import { describe, expect, it } from "vitest";
import type { LinkConfig, Packet } from "../src/contracts";
import { VirtualNetwork, type RandomSource } from "../src/comms/network";
import {
  createPacket,
  crc32,
  decodePacket,
  encodePacket,
  stableStringify,
  validatePacket
} from "../src/comms/protocol";

const noFaultConfig = (overrides: Partial<LinkConfig> = {}): LinkConfig => ({
  baseLatencyMs: 0,
  jitterMs: 0,
  lossRate: 0,
  duplicateRate: 0,
  corruptionRate: 0,
  bandwidthPacketsPerSecond: 1_000,
  ...overrides
});

const rng: RandomSource = { nextFloat: () => 0.5 };

const sequenceRng = (values: number[]): RandomSource => {
  let index = 0;
  return {
    nextFloat: () => {
      const value = values[index];
      index += 1;
      if (value === undefined) throw new Error("测试 RNG 样本不足");
      return value;
    }
  };
};

const packet = (sequence = 1, expiresTick = 100): Packet<{ b: number; a: number }> =>
  createPacket({
    source: "rocket",
    destination: "coordinator",
    type: "VEHICLE_STATE",
    sequence,
    producedTick: 0,
    expiresTick
  }, { b: 2, a: 1 });

describe("通信协议", () => {
  it("稳定规范化 JSON，并使用标准 CRC32", () => {
    expect(stableStringify({ z: 1, a: { y: 2, x: 3 } }))
      .toBe('{"a":{"x":3,"y":2},"z":1}');
    expect(crc32("123456789")).toBe(0xcbf43926);
  });

  it("创建、编码和解码后 CRC 仍有效，篡改载荷会被拒绝", () => {
    const original = packet();
    const decoded = decodePacket<{ b: number; a: number }>(encodePacket(original));
    expect(decoded).toEqual(original);
    expect(validatePacket(decoded)).toBe(true);

    const tampered = { ...decoded, payload: { ...decoded.payload, a: 99 } };
    expect(validatePacket(tampered)).toBe(false);
  });
});

describe("确定性虚拟链路", () => {
  it("按基础时延交付并记录链路统计", () => {
    const network = new VirtualNetwork(noFaultConfig({ baseLatencyMs: 20 }), 10, rng);
    network.send(packet(), 0);

    expect(network.advanceTo(1)).toEqual([]);
    expect(network.advanceTo(2)).toHaveLength(1);
    expect(network.getStats()).toMatchObject({
      sent: 1,
      delivered: 1,
      latencySamplesMs: [20],
      lastValidDeliveryTick: 2
    });
  });

  it("注入 RNG 后抖动始终落在配置边界内", () => {
    const network = new VirtualNetwork(
      noFaultConfig({
        baseLatencyMs: 10,
        jitterMs: 5,
        bandwidthPacketsPerSecond: 1_000_000_000
      }),
      1,
      sequenceRng([0, 0.999])
    );
    network.send(packet(1), 0);
    network.send(packet(2), 0);

    expect(network.advanceTo(5).map((message) => message.header.sequence)).toEqual([1]);
    expect(network.advanceTo(14)).toEqual([]);
    expect(network.advanceTo(15).map((message) => message.header.sequence)).toEqual([2]);
    expect(network.getStats().latencySamplesMs).toEqual([5, 15]);
  });

  it("带宽不足时把后续消息排队", () => {
    const network = new VirtualNetwork(
      noFaultConfig({ bandwidthPacketsPerSecond: 10 }),
      10,
      rng
    );
    network.send(packet(1), 0);
    network.send(packet(2), 0);

    expect(network.advanceTo(0).map((message) => message.header.sequence)).toEqual([1]);
    expect(network.advanceTo(9)).toEqual([]);
    expect(network.advanceTo(10).map((message) => message.header.sequence)).toEqual([2]);
  });

  it("按配置丢包且不产生待交付消息", () => {
    const network = new VirtualNetwork(noFaultConfig({ lossRate: 1 }), 10, rng);
    network.send(packet(), 0);

    expect(network.getPendingCount()).toBe(0);
    expect(network.advanceTo(100)).toEqual([]);
    expect(network.getStats()).toMatchObject({ sent: 1, dropped: 1, delivered: 0 });
  });

  it("检测损坏包并拒绝 CRC 错误", () => {
    const network = new VirtualNetwork(noFaultConfig({ corruptionRate: 1 }), 10, rng);
    network.send(packet(), 0);

    expect(network.advanceTo(0)).toEqual([]);
    expect(network.getStats()).toMatchObject({ corrupted: 1, delivered: 0 });
  });

  it("只交付一次重复序号并统计重复副本", () => {
    const network = new VirtualNetwork(
      noFaultConfig({ duplicateRate: 1, bandwidthPacketsPerSecond: 1_000 }),
      1,
      rng
    );
    network.send(packet(), 0);

    expect(network.advanceTo(1)).toHaveLength(1);
    expect(network.getStats()).toMatchObject({
      duplicated: 1,
      delivered: 1,
      rejectedDuplicate: 1
    });
  });

  it("拒绝在到达时已经过期的消息", () => {
    const network = new VirtualNetwork(noFaultConfig({ baseLatencyMs: 20 }), 10, rng);
    network.send(packet(1, 1), 0);

    expect(network.advanceTo(2)).toEqual([]);
    expect(network.getStats()).toMatchObject({ expired: 1, delivered: 0 });
  });
});

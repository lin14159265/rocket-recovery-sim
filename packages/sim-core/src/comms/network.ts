import type { LinkConfig, NetworkStats, Packet } from "../contracts";
import {
  decodePacket,
  encodePacket,
  stableStringify,
  validatePacket
} from "./protocol";

export interface RandomSource {
  /** 返回 [0, 1) 内的确定性伪随机数。 */
  nextFloat(): number;
}

interface PendingTransmission {
  encoded: string;
  enqueuedTick: number;
  deliveryTick: number;
  order: number;
}

const createEmptyStats = (): NetworkStats => ({
  sent: 0,
  delivered: 0,
  dropped: 0,
  corrupted: 0,
  duplicated: 0,
  expired: 0,
  rejectedDuplicate: 0,
  latencySamplesMs: [],
  lastValidDeliveryTick: -1
});

const requireTick = (tick: number, label: string): void => {
  if (!Number.isSafeInteger(tick) || tick < 0) {
    throw new RangeError(`${label} 必须是非负安全整数 tick`);
  }
};

const requireProbability = (value: number, label: string): void => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} 必须位于 [0, 1]`);
  }
};

const validateConfig = (config: LinkConfig, tickDurationMs: number): void => {
  if (!Number.isFinite(tickDurationMs) || tickDurationMs <= 0) {
    throw new RangeError("tickDurationMs 必须大于 0");
  }
  if (!Number.isFinite(config.baseLatencyMs) || config.baseLatencyMs < 0) {
    throw new RangeError("baseLatencyMs 必须是非负有限数");
  }
  if (!Number.isFinite(config.jitterMs) || config.jitterMs < 0) {
    throw new RangeError("jitterMs 必须是非负有限数");
  }
  if (!Number.isFinite(config.bandwidthPacketsPerSecond)
    || config.bandwidthPacketsPerSecond <= 0) {
    throw new RangeError("bandwidthPacketsPerSecond 必须大于 0");
  }
  requireProbability(config.lossRate, "lossRate");
  requireProbability(config.duplicateRate, "duplicateRate");
  requireProbability(config.corruptionRate, "corruptionRate");
};

/**
 * 单向/共享介质的确定性虚拟链路。
 *
 * 调用方负责按整数 tick 调用 send/advanceTo。链路内部不读取墙上时间，
 * 所有随机决策都来自构造时注入的 RandomSource。
 */
export class VirtualNetwork {
  private readonly config: LinkConfig;
  private readonly tickDurationMs: number;
  private readonly rng: RandomSource;
  private readonly networkStats = createEmptyStats();
  private readonly acceptedSequences = new Set<string>();
  private readonly pending: PendingTransmission[] = [];
  private nextTransmissionAvailableMs = 0;
  private insertionOrder = 0;
  private advancedThroughTick = -1;

  constructor(config: LinkConfig, tickDurationMs: number, rng: RandomSource) {
    validateConfig(config, tickDurationMs);
    this.config = { ...config };
    this.tickDurationMs = tickDurationMs;
    this.rng = rng;
  }

  send<T>(packet: Packet<T>, currentTick: number): void {
    requireTick(currentTick, "currentTick");
    if (currentTick < this.advancedThroughTick) {
      throw new RangeError("不能向已经推进过去的 tick 发送消息");
    }
    if (!validatePacket<T>(packet)) {
      throw new TypeError("send 只接受结构和 CRC 均有效的消息");
    }
    if (packet.header.producedTick > currentTick) {
      throw new RangeError("消息 producedTick 不能晚于发送 tick");
    }

    this.networkStats.sent += 1;
    if (this.sampleProbability(this.config.lossRate)) {
      this.networkStats.dropped += 1;
      return;
    }

    const encoded = encodePacket(packet);
    const duplicate = this.sampleProbability(this.config.duplicateRate);
    this.enqueueCopy(encoded, currentTick);
    if (duplicate) {
      this.networkStats.duplicated += 1;
      this.enqueueCopy(encoded, currentTick);
    }
  }

  /** 推进链路并返回截至 currentTick 已被接收端接受的消息。 */
  advanceTo(currentTick: number): Packet<unknown>[] {
    requireTick(currentTick, "currentTick");
    if (currentTick < this.advancedThroughTick) {
      throw new RangeError("虚拟链路不能倒退");
    }
    this.advancedThroughTick = currentTick;

    const accepted: Packet<unknown>[] = [];
    while ((this.pending[0]?.deliveryTick ?? Number.POSITIVE_INFINITY) <= currentTick) {
      const transmission = this.pending.shift();
      if (transmission === undefined) break;

      let packet: Packet<unknown>;
      try {
        packet = decodePacket(transmission.encoded);
      } catch {
        this.networkStats.corrupted += 1;
        continue;
      }

      if (!validatePacket(packet)) {
        this.networkStats.corrupted += 1;
        continue;
      }
      if (transmission.deliveryTick > packet.header.expiresTick) {
        this.networkStats.expired += 1;
        continue;
      }

      const sequenceKey = [
        packet.header.source,
        packet.header.destination,
        packet.header.sequence
      ].join("\u0000");
      if (this.acceptedSequences.has(sequenceKey)) {
        this.networkStats.rejectedDuplicate += 1;
        continue;
      }
      this.acceptedSequences.add(sequenceKey);

      this.networkStats.delivered += 1;
      this.networkStats.lastValidDeliveryTick = transmission.deliveryTick;
      this.networkStats.latencySamplesMs.push(
        (transmission.deliveryTick - transmission.enqueuedTick) * this.tickDurationMs
      );
      accepted.push(packet);
    }
    return accepted;
  }

  /** advanceTo 的语义别名，便于逐 tick 仿真循环使用。 */
  receiveDue(currentTick: number): Packet<unknown>[] {
    return this.advanceTo(currentTick);
  }

  getStats(): NetworkStats {
    return {
      ...this.networkStats,
      latencySamplesMs: [...this.networkStats.latencySamplesMs]
    };
  }

  getPendingCount(): number {
    return this.pending.length;
  }

  private enqueueCopy(encoded: string, currentTick: number): void {
    const corrupted = this.sampleProbability(this.config.corruptionRate)
      ? this.corruptWirePacket(encoded)
      : encoded;
    const jitterMs = this.config.jitterMs === 0
      ? 0
      : (2 * this.sampleUnit() - 1) * this.config.jitterMs;
    const latencyMs = Math.max(0, this.config.baseLatencyMs + jitterMs);
    const enqueuedMs = currentTick * this.tickDurationMs;
    const transmissionStartMs = Math.max(enqueuedMs, this.nextTransmissionAvailableMs);
    const serviceTimeMs = 1_000 / this.config.bandwidthPacketsPerSecond;
    this.nextTransmissionAvailableMs = transmissionStartMs + serviceTimeMs;

    const deliveryMs = transmissionStartMs + latencyMs;
    const deliveryTick = Math.max(
      currentTick,
      Math.ceil((deliveryMs - Number.EPSILON) / this.tickDurationMs)
    );
    this.insertPending({
      encoded: corrupted,
      enqueuedTick: currentTick,
      deliveryTick,
      order: this.insertionOrder
    });
    this.insertionOrder += 1;
  }

  private insertPending(transmission: PendingTransmission): void {
    let low = 0;
    let high = this.pending.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = this.pending[middle];
      if (candidate === undefined) break;
      const candidateComesFirst = candidate.deliveryTick < transmission.deliveryTick
        || (candidate.deliveryTick === transmission.deliveryTick
          && candidate.order < transmission.order);
      if (candidateComesFirst) low = middle + 1;
      else high = middle;
    }
    this.pending.splice(low, 0, transmission);
  }

  private corruptWirePacket(encoded: string): string {
    const packet = decodePacket(encoded);
    return stableStringify({ ...packet, crc32: (packet.crc32 ^ 1) >>> 0 });
  }

  private sampleProbability(probability: number): boolean {
    if (probability <= 0) return false;
    if (probability >= 1) return true;
    return this.sampleUnit() < probability;
  }

  private sampleUnit(): number {
    const value = this.rng.nextFloat();
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new RangeError("RandomSource.nextFloat() 必须返回 [0, 1) 内的有限数");
    }
    return value;
  }
}

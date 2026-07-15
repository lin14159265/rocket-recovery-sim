import type {
  MessageType,
  NodeId,
  Packet,
  PacketHeader
} from "../contracts";

const NODE_IDS = new Set<NodeId>([
  "rocket",
  "coordinator",
  "winch-x-negative",
  "winch-x-positive",
  "winch-y-negative",
  "winch-y-positive"
]);

const MESSAGE_TYPES = new Set<MessageType>([
  "HEARTBEAT",
  "VEHICLE_STATE",
  "CAPTURE_PLAN",
  "CAPTURE_READY",
  "GUIDANCE_UPDATE",
  "COMMIT",
  "ABORT",
  "WINCH_COMMAND",
  "WINCH_STATUS",
  "TENSION_STATUS"
]);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let byte = 0; byte < table.length; byte += 1) {
    let value = byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0
        ? 0xedb88320 ^ (value >>> 1)
        : value >>> 1;
    }
    table[byte] = value >>> 0;
  }
  return table;
})();

export type PacketHeaderInput = Omit<PacketHeader, "version"> & {
  version?: 1;
};

export class PacketProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PacketProtocolError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeJson = (value: unknown, active: Set<object>): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new PacketProtocolError("协议 JSON 不允许 NaN 或无穷数");
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (typeof value !== "object") {
    throw new PacketProtocolError(`协议 JSON 不支持 ${typeof value}`);
  }

  if (active.has(value)) {
    throw new PacketProtocolError("协议 JSON 不允许循环引用");
  }

  active.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeJson(item, active));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new PacketProtocolError("协议 JSON 仅支持普通对象和数组");
    }

    const normalized = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeJson((value as Record<string, unknown>)[key], active);
    }
    return normalized;
  } finally {
    active.delete(value);
  }
};

/** 将 JSON 值规范化为键顺序稳定、跨运行一致的字符串。 */
export const stableStringify = (value: unknown): string =>
  JSON.stringify(normalizeJson(value, new Set<object>()));

/** 标准 IEEE CRC-32（多项式 0xEDB88320）。 */
export const crc32 = (input: string | Uint8Array): number => {
  const bytes = typeof input === "string" ? textEncoder.encode(input) : input;
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    const tableValue = crcTable[(checksum ^ byte) & 0xff];
    if (tableValue === undefined) {
      throw new PacketProtocolError("CRC32 查表索引越界");
    }
    checksum = tableValue ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
};

export const calculatePacketCrc32 = (
  packet: Pick<Packet<unknown>, "header" | "payload">
): number => crc32(stableStringify({ header: packet.header, payload: packet.payload }));

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const hasValidHeader = (header: unknown): header is PacketHeader => {
  if (!isRecord(header)) return false;
  return header.version === 1
    && typeof header.source === "string"
    && NODE_IDS.has(header.source as NodeId)
    && typeof header.destination === "string"
    && NODE_IDS.has(header.destination as NodeId)
    && typeof header.type === "string"
    && MESSAGE_TYPES.has(header.type as MessageType)
    && isNonNegativeSafeInteger(header.sequence)
    && isNonNegativeSafeInteger(header.producedTick)
    && isNonNegativeSafeInteger(header.expiresTick)
    && header.expiresTick >= header.producedTick;
};

/** 同时检查运行时结构、规范化可编码性与 CRC。 */
export const validatePacket = <T = unknown>(candidate: unknown): candidate is Packet<T> => {
  if (!isRecord(candidate) || !hasValidHeader(candidate.header)) return false;
  if (!isNonNegativeSafeInteger(candidate.crc32) || candidate.crc32 > 0xffffffff) {
    return false;
  }

  try {
    return candidate.crc32 === calculatePacketCrc32({
      header: candidate.header,
      payload: candidate.payload
    });
  } catch {
    return false;
  }
};

export const createPacket = <T>(header: PacketHeaderInput, payload: T): Packet<T> => {
  const packetHeader: PacketHeader = {
    version: header.version ?? 1,
    source: header.source,
    destination: header.destination,
    type: header.type,
    sequence: header.sequence,
    producedTick: header.producedTick,
    expiresTick: header.expiresTick
  };

  if (!hasValidHeader(packetHeader)) {
    throw new PacketProtocolError("消息头字段无效");
  }

  const crc = calculatePacketCrc32({ header: packetHeader, payload });
  return { header: packetHeader, payload, crc32: crc };
};

/** 编码器拒绝无效 CRC，避免调用方无意间把坏包注入链路。 */
export const encodePacket = (packet: Packet<unknown>): string => {
  if (!validatePacket(packet)) {
    throw new PacketProtocolError("无法编码结构或 CRC 无效的消息");
  }
  return stableStringify(packet);
};

/** 解码只负责线格式；是否接受该包由 validatePacket 和接收链路决定。 */
export const decodePacket = <T = unknown>(encoded: string | Uint8Array): Packet<T> => {
  let text: string;
  try {
    text = typeof encoded === "string" ? encoded : textDecoder.decode(encoded);
  } catch (error) {
    throw new PacketProtocolError("消息不是有效的 UTF-8", { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new PacketProtocolError("消息不是有效的 JSON", { cause: error });
  }

  if (!isRecord(parsed)) {
    throw new PacketProtocolError("消息根节点必须是对象");
  }
  return parsed as unknown as Packet<T>;
};

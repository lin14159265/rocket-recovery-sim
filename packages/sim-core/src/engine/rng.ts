/**
 * Serializable state for {@link DeterministicRng}.  Keeping the cached normal
 * sample is important: restoring only the integer state would change the
 * sequence returned by `normal()`.
 */
export interface DeterministicRngState {
  state: number;
  spareNormal: number | null;
}

/**
 * Small deterministic pseudo-random generator for repeatable simulations.
 *
 * The uniform stream is Mulberry32.  It is not cryptographically secure, but
 * it has a full 32-bit state, is inexpensive, and is stable across JavaScript
 * engines because all integer operations are explicitly 32 bit.
 */
export class DeterministicRng {
  private state: number;
  private spareNormal: number | null = null;

  public constructor(seed: number) {
    if (!Number.isFinite(seed)) {
      throw new RangeError("RNG seed must be a finite number");
    }
    this.state = Math.trunc(seed) >>> 0;
  }

  /** Returns an unsigned integer in the inclusive range [0, 2^32 - 1]. */
  public nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }

  /** Returns a uniformly distributed value in the half-open range [0, 1). */
  public nextFloat(): number {
    return this.nextUint32() / 0x1_0000_0000;
  }

  /** Returns a uniformly distributed value in the half-open range [min, max). */
  public uniform(minimum = 0, maximum = 1): number {
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum < minimum) {
      throw new RangeError("Uniform bounds must be finite and maximum >= minimum");
    }
    return minimum + (maximum - minimum) * this.nextFloat();
  }

  /** Returns an integer in the inclusive range [minimum, maximum]. */
  public integer(minimum: number, maximum: number): number {
    const lower = Math.ceil(minimum);
    const upper = Math.floor(maximum);
    if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(upper) || upper < lower) {
      throw new RangeError("Integer bounds must describe a non-empty safe-integer range");
    }

    const span = upper - lower + 1;
    if (span > 0x1_0000_0000) {
      throw new RangeError("Integer range cannot exceed 2^32 values");
    }

    // Rejection sampling avoids the modulo bias that would otherwise matter
    // for packet-loss and Monte-Carlo experiments with small samples.
    const limit = Math.floor(0x1_0000_0000 / span) * span;
    let sample: number;
    do {
      sample = this.nextUint32();
    } while (sample >= limit);
    return lower + (sample % span);
  }

  /** Returns true with the supplied probability. */
  public bernoulli(probability: number): boolean {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new RangeError("Bernoulli probability must be in [0, 1]");
    }
    return this.nextFloat() < probability;
  }

  /** Returns a Gaussian sample using the Marsaglia polar transform. */
  public normal(mean = 0, standardDeviation = 1): number {
    if (!Number.isFinite(mean) || !Number.isFinite(standardDeviation) || standardDeviation < 0) {
      throw new RangeError("Normal parameters must be finite and standard deviation >= 0");
    }
    if (standardDeviation === 0) return mean;

    if (this.spareNormal !== null) {
      const sample = this.spareNormal;
      this.spareNormal = null;
      return mean + standardDeviation * sample;
    }

    let first: number;
    let second: number;
    let radiusSquared: number;
    do {
      first = 2 * this.nextFloat() - 1;
      second = 2 * this.nextFloat() - 1;
      radiusSquared = first * first + second * second;
    } while (radiusSquared <= Number.EPSILON || radiusSquared >= 1);

    const scale = Math.sqrt((-2 * Math.log(radiusSquared)) / radiusSquared);
    this.spareNormal = second * scale;
    return mean + standardDeviation * first * scale;
  }

  public getState(): DeterministicRngState {
    return { state: this.state, spareNormal: this.spareNormal };
  }

  public setState(state: DeterministicRngState): void {
    if (!Number.isSafeInteger(state.state) || state.state < 0 || state.state > 0xffff_ffff) {
      throw new RangeError("RNG state must be an unsigned 32-bit integer");
    }
    if (state.spareNormal !== null && !Number.isFinite(state.spareNormal)) {
      throw new RangeError("Cached normal sample must be finite or null");
    }
    this.state = state.state >>> 0;
    this.spareNormal = state.spareNormal;
  }

  public clone(): DeterministicRng {
    const clone = new DeterministicRng(0);
    clone.setState(this.getState());
    return clone;
  }
}

export const createDeterministicRng = (seed: number): DeterministicRng =>
  new DeterministicRng(seed);

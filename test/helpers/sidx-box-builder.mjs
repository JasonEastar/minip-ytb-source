// ─── sidx fixture builder (ISO/IEC 14496-12 §8.16.3) ────────────────────────

function u16(value) {
  return [(value >>> 8) & 0xff, value & 0xff];
}

export function u32(value) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u64(value) {
  const high = Math.floor(value / 2 ** 32);
  const low = value % 2 ** 32;
  return [...u32(high), ...u32(low)];
}

export function ascii(text) {
  return [...text].map((char) => char.charCodeAt(0));
}

/** Plain box with a type and arbitrary payload (used for non-sidx boxes). */
export function box(type, payload = []) {
  return [...u32(8 + payload.length), ...ascii(type), ...payload];
}

/**
 * Build a `sidx` box. `references` entries: { size, duration, type = 0 }.
 * `largeSize` writes the 64-bit box size header (size field = 1).
 */
export function buildSidx({
  version = 0,
  largeSize = false,
  referenceId = 1,
  timescale,
  earliestPresentationTime = 0,
  firstOffset = 0,
  references,
  referenceCount = references.length,
}) {
  const body = [
    version,
    0,
    0,
    0, // flags
    ...u32(referenceId),
    ...u32(timescale),
    ...(version === 0 ? u32(earliestPresentationTime) : u64(earliestPresentationTime)),
    ...(version === 0 ? u32(firstOffset) : u64(firstOffset)),
    ...u16(0), // reserved
    ...u16(referenceCount),
  ];
  for (const reference of references) {
    const type = reference.type ?? 0;
    body.push(
      ...u32(((type << 31) | reference.size) >>> 0),
      ...u32(reference.duration),
      ...u32(0x90000000) // starts_with_SAP=1, SAP_type=1, SAP_delta_time=0
    );
  }
  const headerSize = largeSize ? 16 : 8;
  const totalSize = headerSize + body.length;
  const header = largeSize
    ? [...u32(1), ...ascii('sidx'), ...u64(totalSize)]
    : [...u32(totalSize), ...ascii('sidx')];
  return { bytes: new Uint8Array([...header, ...body]), size: totalSize };
}

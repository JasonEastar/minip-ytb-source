/**
 * Test the defragmentation logic in pure JS (matching the Swift defragmenter).
 * Takes a fragmented MP4 input, defragments it, verifies output is playable.
 */
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

const INPUT = process.argv[2] || '/tmp/test-frag-input.m4a';

function readU32(data: Buffer, offset: number): number {
  return data.readUInt32BE(offset);
}

function readI32(data: Buffer, offset: number): number {
  return data.readInt32BE(offset);
}

function readAscii(data: Buffer, offset: number, len: number): string {
  return data.subarray(offset, offset + len).toString('ascii');
}

interface Box {
  type: string;
  offset: number;
  size: number;
  headerSize: number;
  children?: Box[];
}

interface Sample {
  duration: number;
  size: number;
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf', 'edts']);

function readBoxes(data: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let pos = start;

  while (pos + 8 <= end) {
    let size = readU32(data, pos);
    const type = readAscii(data, pos + 4, 4);
    let hdr = 8;

    if (size === 1 && pos + 16 <= end) {
      const hi = BigInt(readU32(data, pos + 8));
      const lo = BigInt(readU32(data, pos + 12));
      size = Number((hi << 32n) | lo);
      hdr = 16;
    } else if (size === 0) {
      size = end - pos;
    }

    if (size < hdr || pos + size > end) break;

    const box: Box = { type, offset: pos, size, headerSize: hdr };
    if (CONTAINERS.has(type)) {
      box.children = readBoxes(data, pos + hdr, pos + size);
    }
    boxes.push(box);
    pos += size;
  }

  return boxes;
}

function findBox(boxes: Box[], type: string): Box | undefined {
  for (const box of boxes) {
    if (box.type === type) return box;
    if (box.children) {
      const found = findBox(box.children, type);
      if (found) return found;
    }
  }
  return undefined;
}

function defragmentMP4(data: Buffer): Buffer {
  const boxes = readBoxes(data, 0, data.length);

  if (!boxes.some(b => b.type === 'moof')) {
    console.log('  Not fragmented, returning as-is');
    return data;
  }

  const moov = findBox(boxes, 'moov');
  if (!moov?.children) { console.log('  No moov'); return data; }

  const mdhd = findBox(moov.children, 'mdhd');
  if (!mdhd) { console.log('  No mdhd'); return data; }
  const mdhdPos = mdhd.offset + mdhd.headerSize;
  const mdhdVer = data[mdhdPos];
  const mediaTimescale = mdhdVer === 0
    ? readU32(data, mdhdPos + 12)
    : readU32(data, mdhdPos + 20);

  console.log(`  Timescale: ${mediaTimescale}`);

  const stsd = findBox(moov.children, 'stsd');
  if (!stsd) { console.log('  No stsd'); return data; }
  const stsdRaw = data.subarray(stsd.offset, stsd.offset + stsd.size);

  let defaultDuration = 0;
  let defaultSize = 0;
  const trex = findBox(moov.children, 'trex');
  if (trex) {
    const tp = trex.offset + trex.headerSize + 4;
    defaultDuration = readU32(data, tp + 8);
    defaultSize = readU32(data, tp + 12);
  }

  const samples: Sample[] = [];
  const audioChunks: Buffer[] = [];

  for (const moof of boxes.filter(b => b.type === 'moof')) {
    if (!moof.children) continue;
    const traf = findBox(moof.children, 'traf');
    if (!traf?.children) continue;

    const tfhd = findBox(traf.children, 'tfhd');
    if (!tfhd) continue;
    const tfhdPos = tfhd.offset + tfhd.headerSize;
    const tfhdFlags = (data[tfhdPos + 1] << 16) | (data[tfhdPos + 2] << 8) | data[tfhdPos + 3];
    let fp = tfhdPos + 8;

    let fragDuration = defaultDuration;
    let fragSize = defaultSize;

    if (tfhdFlags & 0x01) fp += 8;
    if (tfhdFlags & 0x02) fp += 4;
    if (tfhdFlags & 0x08) { fragDuration = readU32(data, fp); fp += 4; }
    if (tfhdFlags & 0x10) { fragSize = readU32(data, fp); fp += 4; }
    if (tfhdFlags & 0x20) fp += 4;

    const trun = findBox(traf.children, 'trun');
    if (!trun) continue;
    const trunPos = trun.offset + trun.headerSize;
    const trunFlags = (data[trunPos + 1] << 16) | (data[trunPos + 2] << 8) | data[trunPos + 3];
    const sampleCount = readU32(data, trunPos + 4);
    let sp = trunPos + 8;

    let dataOffset = 0;
    if (trunFlags & 0x001) { dataOffset = readI32(data, sp); sp += 4; }
    if (trunFlags & 0x004) sp += 4;

    let chunkBytes = 0;
    for (let j = 0; j < sampleCount; j++) {
      let dur = fragDuration;
      let sz = fragSize;
      if (trunFlags & 0x100) { dur = readU32(data, sp); sp += 4; }
      if (trunFlags & 0x200) { sz = readU32(data, sp); sp += 4; }
      if (trunFlags & 0x400) sp += 4;
      if (trunFlags & 0x800) sp += 4;
      samples.push({ duration: dur, size: sz });
      chunkBytes += sz;
    }

    const audioStart = moof.offset + dataOffset;
    const audioEnd = audioStart + chunkBytes;
    if (audioStart >= 0 && audioEnd <= data.length) {
      audioChunks.push(data.subarray(audioStart, audioEnd));
    }
  }

  if (samples.length === 0) { console.log('  No samples'); return data; }

  const totalDuration = samples.reduce((a, s) => a + s.duration, 0);
  const totalAudioSize = audioChunks.reduce((a, c) => a + c.length, 0);
  console.log(`  Samples: ${samples.length}, Duration: ${totalDuration}, Audio: ${totalAudioSize} bytes`);

  // Build stts entries
  const sttsEntries: { count: number; delta: number }[] = [];
  let curDelta = samples[0].duration;
  let curCount = 1;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].duration === curDelta) {
      curCount++;
    } else {
      sttsEntries.push({ count: curCount, delta: curDelta });
      curDelta = samples[i].duration;
      curCount = 1;
    }
  }
  sttsEntries.push({ count: curCount, delta: curDelta });

  const numSamples = samples.length;
  const numStts = sttsEntries.length;

  const sttsSize = 12 + 4 + numStts * 8;
  const stscSize = 12 + 4 + 12;  // fullbox(12) + entry_count(4) + one entry(12)
  const stszSize = 12 + 4 + 4 + numSamples * 4;
  const stcoSize = 12 + 4 + 4;
  const stblSize = 8 + stsdRaw.length + sttsSize + stscSize + stszSize + stcoSize;
  const smhdSize = 12 + 4;
  const urlBoxSize = 12;
  const drefSize = 12 + 4 + urlBoxSize;
  const dinfSize = 8 + drefSize;
  const minfSize = 8 + smhdSize + dinfSize + stblSize;
  const mdhdSize = 12 + 20;
  const hdlrSize = 12 + 4 + 4 + 12 + 13;
  const mdiaSize = 8 + mdhdSize + hdlrSize + minfSize;
  const tkhdSize = 12 + 80;
  const trakSize = 8 + tkhdSize + mdiaSize;
  const mvhdSize = 12 + 96;
  const moovSize = 8 + mvhdSize + trakSize;
  const ftypSize = 8 + 4 + 4 + 12;
  const outputSize = ftypSize + moovSize + 8 + totalAudioSize;

  const out = Buffer.alloc(outputSize);
  let o = 0;

  function writeU32(val: number) { out.writeUInt32BE(val, o); o += 4; }
  function writeU16(val: number) { out.writeUInt16BE(val, o); o += 2; }
  function writeAscii(s: string) { out.write(s, o, 'ascii'); o += s.length; }
  function writeBoxHdr(size: number, type: string) { writeU32(size); writeAscii(type); }
  function writeFullBoxHdr(size: number, type: string, ver: number, flags: number) {
    writeBoxHdr(size, type);
    out[o] = ver; o++;
    out[o] = (flags >> 16) & 0xff; o++;
    out[o] = (flags >> 8) & 0xff; o++;
    out[o] = flags & 0xff; o++;
  }
  function writeMatrix() {
    out.writeUInt32BE(0x00010000, o);
    out.writeUInt32BE(0x00010000, o + 16);
    out.writeUInt32BE(0x40000000, o + 32);
    o += 36;
  }
  function skip(n: number) { o += n; }

  // ftyp
  writeBoxHdr(ftypSize, 'ftyp'); writeAscii('M4A '); writeU32(0);
  writeAscii('M4A '); writeAscii('isom'); writeAscii('mp42');

  // moov
  writeBoxHdr(moovSize, 'moov');
  writeFullBoxHdr(mvhdSize, 'mvhd', 0, 0);
  writeU32(0); writeU32(0); writeU32(mediaTimescale); writeU32(totalDuration);
  writeU32(0x00010000); writeU16(0x0100); skip(10); writeMatrix(); skip(24); writeU32(2);

  writeBoxHdr(trakSize, 'trak');
  writeFullBoxHdr(tkhdSize, 'tkhd', 0, 3);
  writeU32(0); writeU32(0); writeU32(1); writeU32(0); writeU32(totalDuration);
  skip(8); skip(4); writeU16(0x0100); skip(2); writeMatrix(); skip(8);

  writeBoxHdr(mdiaSize, 'mdia');
  writeFullBoxHdr(mdhdSize, 'mdhd', 0, 0);
  writeU32(0); writeU32(0); writeU32(mediaTimescale); writeU32(totalDuration);
  writeU16(0x55c4); writeU16(0);

  writeFullBoxHdr(hdlrSize, 'hdlr', 0, 0);
  writeU32(0); writeAscii('soun'); skip(12);
  out.write('SoundHandler', o, 'ascii'); o += 13;

  writeBoxHdr(minfSize, 'minf');
  writeFullBoxHdr(smhdSize, 'smhd', 0, 0); skip(4);

  writeBoxHdr(dinfSize, 'dinf');
  writeFullBoxHdr(drefSize, 'dref', 0, 0); writeU32(1);
  writeFullBoxHdr(urlBoxSize, 'url ', 0, 1);

  writeBoxHdr(stblSize, 'stbl');
  stsdRaw.copy(out, o); o += stsdRaw.length;

  // stts
  writeFullBoxHdr(sttsSize, 'stts', 0, 0);
  writeU32(numStts);
  for (const entry of sttsEntries) { writeU32(entry.count); writeU32(entry.delta); }

  // stsc — THIS IS THE FIX: entry_count(1), first_chunk(1), samples_per_chunk(numSamples), sample_desc_idx(1)
  writeFullBoxHdr(stscSize, 'stsc', 0, 0);
  writeU32(1);           // entry_count
  writeU32(1);           // first_chunk
  writeU32(numSamples);  // samples_per_chunk
  writeU32(1);           // sample_description_index

  // stsz
  writeFullBoxHdr(stszSize, 'stsz', 0, 0);
  writeU32(0); writeU32(numSamples);
  for (const s of samples) writeU32(s.size);

  // stco
  const stcoOffset = o;
  writeFullBoxHdr(stcoSize, 'stco', 0, 0);
  writeU32(1); writeU32(0);

  // mdat
  writeBoxHdr(8 + totalAudioSize, 'mdat');
  const mdatDataOffset = o;
  for (const chunk of audioChunks) {
    chunk.copy(out, o); o += chunk.length;
  }

  out.writeUInt32BE(mdatDataOffset, stcoOffset + 16);

  console.log(`  Output size: ${o} (allocated: ${outputSize})`);
  return out.subarray(0, o);
}

// Main
const data = readFileSync(INPUT);
console.log(`Input: ${INPUT} (${data.length} bytes)`);

// Show input boxes
const boxes = readBoxes(data, 0, data.length);
console.log(`Input boxes: ${boxes.map(b => b.type).join(', ')}`);
console.log(`Fragments: ${boxes.filter(b => b.type === 'moof').length}`);

// Defragment
console.log('\nDefragmenting...');
const result = defragmentMP4(data);

const outFile = '/tmp/test-defrag-output.m4a';
writeFileSync(outFile, result);
console.log(`\nOutput: ${outFile} (${result.length} bytes)`);

// Verify with ffprobe
try {
  const out = execSync(`ffprobe -v error -show_format -show_streams "${outFile}" 2>&1`).toString();
  const lines = out.split('\n').filter(l =>
    l.includes('codec') || l.includes('duration') || l.includes('format') ||
    l.includes('sample_rate') || l.includes('channels') || l.includes('bit_rate')
  );
  console.log('\nffprobe output:');
  for (const line of lines) console.log(`  ${line}`);
} catch (e: any) {
  console.log('ffprobe error:', (e.stdout || e.stderr || '').toString().slice(0, 300));
}

// Decode test
try {
  execSync(`ffmpeg -y -v error -i "${outFile}" -f null /dev/null 2>&1`, { timeout: 30000 });
  console.log('\n✅ DEFRAGMENTED FILE IS FULLY PLAYABLE');
} catch (e: any) {
  console.log('\n❌ DEFRAGMENTED FILE IS NOT PLAYABLE');
  console.log((e.stdout || e.stderr || '').toString().slice(0, 500));
}

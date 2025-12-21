/**
 * Test KLV Parser with sample files
 */
import { readFileSync } from 'fs';
import { parseKLV, formatKLVForDisplay } from './src/parsers/klv.js';

// Test with binary KLV sample
console.log('=== Testing KLV Parser ===\n');

try {
  const sample = readFileSync('../samples/DynamicConstantMISMMSPacketData.bin');
  console.log(`Loaded sample: ${sample.length} bytes`);
  console.log(`Hex: ${sample.subarray(0, 32).toString('hex')}...\n`);

  const { packets } = parseKLV(sample);
  console.log(`Parsed ${packets.length} packet(s)\n`);

  for (const packet of packets) {
    console.log('--- Raw packet ---');
    console.log(JSON.stringify(packet, null, 2));
    console.log('\n--- Formatted ---');
    console.log(JSON.stringify(formatKLVForDisplay(packet), null, 2));
  }
} catch (e) {
  console.error('Error:', e.message);
}

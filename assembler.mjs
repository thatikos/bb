// Updated assembler.mjs with MUL instruction
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Updated OPCODES with MUL instruction
export const OPCODES = {
  MOVI: 0x01,
  MOV : 0x02,
  ADD : 0x03,
  SUB : 0x04,
  ADDI: 0x05,
  SUBI: 0x06,
  LOAD: 0x07,
  STR : 0x08,
  MUL : 0x09,  // Added MUL instruction
};

function parseRegister(tok) {
  if (!tok.startsWith('R')) throw new Error(`Invalid register: ${tok}`);
  const num = Number(tok.slice(1));
  if (Number.isNaN(num) || num < 0 || num > 255)
    throw new Error(`Register out of range: ${tok}`);
  return num;
}

function assembleLine(line) {
  const parts = line.trim().split(/\s+/);
  const mnem  = parts[0].toUpperCase();
  const op    = OPCODES[mnem];
  if (op === undefined) throw new Error(`Unknown mnemonic: ${mnem}`);

  let rd = 0, rn = 0, rm = 0;
  switch (mnem) {
    case 'MOVI':
      rd = parseRegister(parts[1]);
      rm = Number(parts[2]);
      break;
    case 'MOV':
      rd = parseRegister(parts[1]);
      rn = parseRegister(parts[2]);
      break;
    case 'ADD': case 'SUB': case 'MUL':  // Added MUL to this case
      rd = parseRegister(parts[1]);
      rn = parseRegister(parts[2]);
      rm = parseRegister(parts[3]);
      break;
    case 'ADDI': case 'SUBI':
      rd = parseRegister(parts[1]);
      rn = parseRegister(parts[2]);
      rm = Number(parts[3]);
      break;
    case 'LOAD': case 'STR':
      rd = parseRegister(parts[1]);
      rn = parseRegister(parts[2]);
      rm = Number(parts[3]);
      break;
    default:
      throw new Error(`Assembler not implemented for ${mnem}`);
  }

  return (op << 24) | (rd << 16) | (rn << 8) | (rm & 0xff);
}

export function assembleFile(inputAsm, outputBin) {
  const lines = fs.readFileSync(inputAsm, 'utf8')
    .split('\n')
    .map(l => l.replace(/;.*/, '').trim())
    .filter(l => l.length);

  const words = lines.map(assembleLine);
  const buf   = Buffer.alloc(words.length * 4);
  words.forEach((w, i) => buf.writeUInt32BE(w, i * 4));

  const outPath = path.resolve(outputBin);
  console.log(`Assembled ${words.length} instructions → ${outPath}`);
  fs.writeFileSync(outPath, buf);
}

// if this file was invoked directly, run the assembler
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  const [ , , inputAsm, outputBin ] = process.argv;

  if (!inputAsm || !outputBin) {
    console.error('Usage: node assembler.mjs <input.asm> <output.bin>');
    process.exit(1);
  }

  try {
    console.log('CWD:', process.cwd());
    assembleFile(inputAsm, outputBin);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

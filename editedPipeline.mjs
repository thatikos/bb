// editedPipeline.mjs
import pkg from 'electron';
const { app, BrowserWindow, ipcMain } = pkg;
import path, { dirname } from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { OPCODES } from './assembler.mjs';
import { MemorySystem } from './cache-simulator.mjs';


// Get __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow;
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  mainWindow.loadFile('index.html');
  mainWindow.webContents.on('did-finish-load', resetSimulationState);

}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// --- Simulation state & helpers ---

// 1) Memory+cache system
const memorySystem = new MemorySystem();

// 2) Pipeline controller
class Pipeline {
  constructor() {
    this.pipelineEnabled = true;
    this.stages = { fetch: null, decode: null, execute: null, memory: null, writeBack: null };
    this.clockCycle = 0;
    this.instructionCount = 0;
    this.stallCount = 0;
  }
  getPerformanceStats() {
    const memStats = memorySystem.getStats();
    return {
      cycles:       this.clockCycle,
      instructions: this.instructionCount,
      stalls:       this.stallCount,
      ipc:          this.clockCycle > 0 ? this.instructionCount / this.clockCycle : 0,
      hitRate:      memStats.hitRate
    };
  }
}
const p = new Pipeline();

// 3) Registers & queue
class Register { constructor(v=0){ this.value=v } read(){return this.value} write(v){this.value=v} }
class GeneralRegisters {
  constructor(){ this.GenRegisters = Array(32).fill(0); }
  read(i){ i=+i; if (i<0||i>31) throw new Error(`Invalid reg ${i}`); return this.GenRegisters[i]; }
  write(i,v){ i=+i; if (i<0||i>31) throw new Error(`Invalid reg ${i}`); this.GenRegisters[i]=v; }
  getAllRegisters(){ return [...this.GenRegisters]; }
}
const registers     = new GeneralRegisters();
const instructionReg= new Register();
const PC            = new Register(-1);
const instructionQueue = [];

// --- GUI formatting ---
function formatInstructionForGUI(instr) {
  if (instr==null) return '-';
  if (typeof instr==='number') {
    return '0x'+instr.toString(16).padStart(8,'0');
  }
  if (typeof instr==='string') return instr;
  let d = instr.type||'NOP';
  switch(instr.type){
    case 'ADD': case 'SUB': case 'MUL':  
      d+= ` R${instr.RdNum}, R${instr.RnNum}, R${instr.RmNum}`;
      if (instr.result!=null) d+= ` [Res:${instr.result}]`;
      break;
    case 'ADDI': case 'SUBI':
      d+= ` R${instr.RdNum}, R${instr.RnNum}, ${instr.immediateStr}`;
      if (instr.result!=null) d+= ` [Res:${instr.result}]`;
      break;
    case 'LOAD': case 'STR':
      d+= ` R${instr.RdNum}, R${instr.RnNum}, ${instr.offsetStr}`;
      if (instr.memoryAddress!=null) d+= ` [Addr:${instr.memoryAddress}]`;
      if (instr.memoryResult!=null)  d+= ` [Val:${instr.memoryResult}]`;
      break;
    case 'MOV':
      d+= ` R${instr.RdNum}, R${instr.RnNum}`;
      if (instr.result!=null) d+= ` [Res:${instr.result}]`;
      break;
    case 'MOVI':
      d+= ` R${instr.RdNum}, ${instr.immediateStr}`;
      if (instr.result!=null) d+= ` [Res:${instr.result}]`;
      break;
    case 'NOP': d='NOP'; break;
  }
  return d;
}

// --- Core cycle logic ---
function doOneCycle() {
    // if pipeline is disabled, fall back to serial execution (one instruction at a time)
    if (!p.pipelineEnabled) {
      runOneInstructionToCompletion();
      // after serial execution, update GUI once and return
      updateGUI();
      return;
    }
  
    // 1) advance clock
    p.clockCycle++;

    // 2) count memory stalls
    const pending = Object.keys(memorySystem.getPendingRequests()).length > 0;
    if (pending) {
      p.stallCount++;
    }

    // 3) snapshot old stages
    const old = { ...p.stages };

    // 4) WRITEBACK
    if (old.writeBack) {
      const i = old.writeBack;
      switch (i.type) {
        case 'ADD': case 'ADDI': case 'SUB': case 'SUBI':
        case 'MOV': case 'MOVI': case 'MUL':
          registers.write(i.RdNum, i.result);
          break;
        case 'LOAD':
          if (i.memoryResult !== undefined) {
            registers.write(i.RdNum, i.memoryResult);
          } else {
            console.warn(`Skipping WB for LOAD to R${i.RdNum} due to missing memory result`);
          }
          break;          
      }
      p.instructionCount++;
    }

    // MEMORY
    let nextMem = null;
    let nextWB = null;

    if (old.memory) {
        const i = old.memory;
        
        if (i.type === 'LOAD') {
          const res = memorySystem.read(i.memoryAddress, 'memory');
          if (res.status === 'done') {
            i.memoryResult = res.data;
            nextWB = i;
          } else {
            // Add a timeout - if memory operation has been stalled for 5 cycles, force completion
            i.stallCycles = (i.stallCycles || 0) + 1;
            if (i.stallCycles >= 5) {
              console.log("Forcing LOAD completion after timeout");
              // Force a value and move on
              i.memoryResult = 0; // Default value
              try {
                // Try to get the value directly from memory
                const { lineIndex, offset } = memorySystem.memory.getLineAndOffset(i.memoryAddress);
                i.memoryResult = memorySystem.memory.data[lineIndex][offset];
              } catch (e) {
                console.error("Error accessing memory directly:", e);
              }
              nextWB = i;
            } else {
              nextMem = i;
            }
          }
        } else if (i.type === 'STR') {
          const val = registers.read(i.RdNum);
          try {
            const res = memorySystem.write(i.memoryAddress, val, 'memory');
            if (res.status === 'done') {
              nextWB = i;
            } else {
              // Add a timeout - if memory operation has been stalled for 5 cycles, force completion
              i.stallCycles = (i.stallCycles || 0) + 1;
              if (i.stallCycles >= 5) {
                console.log("Forcing STR completion after timeout");
                // Force the store directly
                try {
                  const { lineIndex, offset } = memorySystem.memory.getLineAndOffset(i.memoryAddress);
                  memorySystem.memory.data[lineIndex][offset] = val;
                } catch (e) {
                  console.error("Error accessing memory directly:", e);
                }
                nextWB = i;
              } else {
                nextMem = i;
              }
            }
          } catch (err) {
            console.error(`Error in STR: ${err.message}`);
            nextWB = i; // Move on to avoid deadlock
          }
        } else {
          // Non-memory operations pass through
          nextWB = i;
        }
      }

    // EXECUTE
    let nextExec = null;
    if (old.execute) {
      const i = old.execute;
      switch(i.type){
        case 'ADD':  i.result = i.RnValue + i.RmValue; break;
        case 'ADDI': i.result = i.RnValue + i.immediate; break;
        case 'SUB':  i.result = i.RnValue - i.RmValue; break;
        case 'SUBI': i.result = i.RnValue - i.immediate; break;
        case 'MOV':  i.result = i.RnValue; break;
        case 'MOVI': i.result = i.immediate; break;
        case 'MUL':  i.result = i.RnValue * i.RmValue; break;
        case 'LOAD': case 'STR':
          i.memoryAddress = i.RnValue + i.offset;
          break;
      }
      nextMem = nextMem || i;
    }

    // DECODE
    let nextDecode = null;
    if (old.decode !== null) {
      const w = old.decode;
      const op = (w>>>24)&0xff;
      const rd = (w>>>16)&0xff;
      const rn = (w>>>8)&0xff;
      const imm8 = w&0xff;
      let instr = { original: w.toString(16).padStart(8,'0') };
      switch(op){
        case OPCODES.MOVI:
          instr.type='MOVI'; instr.RdNum=rd;
          instr.immediate=imm8; instr.immediateStr=imm8.toString();
          break;
        case OPCODES.MOV:
          instr.type='MOV'; instr.RdNum=rd; instr.RnNum=rn; break;
        case OPCODES.ADD:
          instr.type='ADD'; instr.RdNum=rd; instr.RnNum=rn; instr.RmNum=imm8; break;
        case OPCODES.SUB:
          instr.type='SUB'; instr.RdNum=rd; instr.RnNum=rn; instr.RmNum=imm8; break;
        case OPCODES.ADDI:
          instr.type='ADDI'; instr.RdNum=rd; instr.RnNum=rn;
          instr.immediate=imm8; instr.immediateStr=imm8.toString(); break;
        case OPCODES.SUBI:
          instr.type='SUBI'; instr.RdNum=rd; instr.RnNum=rn;
          instr.immediate=imm8; instr.immediateStr=imm8.toString(); break;
        case OPCODES.LOAD:
          instr.type='LOAD'; instr.RdNum=rd; instr.RnNum=rn;
          instr.offset=imm8; instr.offsetStr=imm8.toString(); break;
        case OPCODES.STR:
          instr.type='STR'; instr.RdNum=rd; instr.RnNum=rn;
          instr.offset=imm8; instr.offsetStr=imm8.toString(); break;
        case OPCODES.MUL:
          instr.type='MUL'; instr.RdNum=rd; instr.RnNum=rn; instr.RmNum=imm8; break;
        default:
          instr.type='NOP';
      }
      if (instr.RnNum!=null) instr.RnValue = registers.read(instr.RnNum);
      if (instr.RmNum!=null) instr.RmValue = registers.read(instr.RmNum);
      nextExec = instr;
    }

    // FETCH - KEY CHANGE HERE
    let nextFetch = null;
    if (instructionQueue.length > 0) {
      // This is the key change: store the next instruction in the fetch stage
      nextFetch = instructionQueue[0]; // Just peek, don't remove yet
      
      // Only advance if decode stage is free to accept the instruction
      if (old.decode === null) {
        PC.write(PC.read() + 1);
        nextFetch = instructionQueue.shift(); // Now remove it
        instructionReg.write(nextFetch);
        nextDecode = nextFetch;
      }
    }

    // Commit the new pipeline registers
    p.stages = {
      fetch:     nextFetch,
      decode:    nextDecode,
      execute:   nextExec,
      memory:    nextMem,
      writeBack: nextWB
    };

    // Push the update back to the renderer
    updateGUI();

    // If everything's now empty, fire "complete"
    if (
      instructionQueue.length === 0 &&
      Object.values(p.stages).every(stage => stage === null) &&
      Object.keys(memorySystem.getPendingRequests()).length === 0
    ) {
      mainWindow.webContents.send('simulation-complete');
    }
}

// step‐by‐step entry point
function simulateClockCycle() {
  doOneCycle();
}

// Serial execution: one instruction from fetch through writeback
function runOneInstructionToCompletion() {
    if (
        instructionQueue.length === 0 &&
        Object.values(p.stages).every(s => s === null) &&
        Object.keys(memorySystem.getPendingRequests()).length === 0
    ) return;

    // FETCH
    p.clockCycle++;
    PC.write(PC.read() + 1);
    const word = instructionQueue.shift();

    // DECODE
    p.clockCycle++;
    const op   = (word >>> 24) & 0xff;
    const rd   = (word >>> 16) & 0xff;
    const rn   = (word >>> 8)  & 0xff;
    const imm8 =  word & 0xff;

    // EXECUTE
    p.clockCycle++;
    let result, addr;
    switch (op) {
        case OPCODES.MOVI:
            result = imm8;
            break;
        case OPCODES.MOV:
            result = registers.read(rn);
            break;
        case OPCODES.ADD:
            result = registers.read(rn) + registers.read(imm8);
            break;
        case OPCODES.SUB:
            result = registers.read(rn) - registers.read(imm8);
            break;
        case OPCODES.ADDI:
            result = registers.read(rn) + imm8;
            break;
        case OPCODES.SUBI:
            result = registers.read(rn) - imm8;
            break;
        case OPCODES.MUL:
            result = registers.read(rn) * registers.read(imm8);
            break;
        case OPCODES.LOAD:
        case OPCODES.STR:
            // CRITICAL FIX: Explicit address calculation
            addr = registers.read(rn) + imm8;
            console.log(`Non-pipelined address calculation: ${registers.read(rn)} + ${imm8} = ${addr}`);
            break;
        default:
            break;
    }

    // MEMORY
    p.clockCycle++;
    if (op === OPCODES.LOAD) {
        let data = 0; // Default to 0
        try {
            if (!memorySystem.cacheEnabled) {
                p.clockCycle += memorySystem.memory.delay - 1;
                const { lineIndex, offset } = memorySystem.memory.ensureMemoryLocation(addr);
                data = memorySystem.memory.data[lineIndex][offset];
            } else {
                const cacheRes = memorySystem.cache.read(addr);
                if (cacheRes.hit) {
                    p.clockCycle += memorySystem.cacheDelay - 1;
                    data = cacheRes.data;
                } else {
                    p.clockCycle += memorySystem.memory.delay - 1;
                    const { lineIndex, offset } = memorySystem.memory.ensureMemoryLocation(addr);
                    const lineData = memorySystem.memory.data[lineIndex];
                    memorySystem.cache.cache[memorySystem.cache.getIndex(addr)]
                        .updateCacheLine(memorySystem.cache.getTag(addr), lineData);
                    data = lineData[offset];
                }
            }
            registers.write(rd, data);
            console.log(`LOAD in non-pipelined mode: address ${addr}, value ${data}`);
        } catch (err) {
            console.error(`Error in non-pipelined LOAD: ${err.message}`);
            registers.write(rd, 0); // Default to 0
        }
    } else if (op === OPCODES.STR) {
        try {
            const val = registers.read(rd);
            console.log(`STR in non-pipelined mode: value ${val} to address ${addr}`);
            
            if (!memorySystem.cacheEnabled) {
                p.clockCycle += memorySystem.memory.delay - 1;
                const { lineIndex, offset } = memorySystem.memory.ensureMemoryLocation(addr);
                memorySystem.memory.data[lineIndex][offset] = val;
            } else {
                const cacheIdx = memorySystem.cache.getIndex(addr);
                const tag = memorySystem.cache.getTag(addr);
                const { lineIndex, offset: memOffset } = memorySystem.memory.ensureMemoryLocation(addr);
                
                if (memorySystem.cache.cache[cacheIdx].isCacheHit(tag)) {
                    p.clockCycle += memorySystem.cacheDelay - 1;
                    memorySystem.cache.totalHits++;
                    memorySystem.cache.cache[cacheIdx].data[memOffset] = val;
                } else {
                    p.clockCycle += memorySystem.memory.delay - 1;
                    memorySystem.cache.totalMisses++;
                }
                memorySystem.memory.data[lineIndex][memOffset] = val;
            }
        } catch (err) {
            console.error(`Error in non-pipelined STR: ${err.message}`);
        }
    }

    // WRITEBACK
    p.clockCycle++;
    if ([OPCODES.MOVI, OPCODES.MOV, OPCODES.ADD, OPCODES.SUB, OPCODES.ADDI, OPCODES.SUBI, OPCODES.MUL].includes(op)) {
        registers.write(rd, result);
    }
    p.instructionCount++;
}

function resetPerformanceCounters() {
    // mirror what resetSimulationState does for clockCycle, instructionCount, stallCount…
    p.clockCycle    = 0;
    p.instructionCount = 0;
    p.stallCount    = 0;
    // reset cache/memory stats too
    memorySystem.resetStats();
  }

//
// GUI‐update & file‐load/reset
//
function updateGUI() {
  if (!mainWindow) return;
  const formatted = {
    fetch:    formatInstructionForGUI(p.stages.fetch),
    decode:   formatInstructionForGUI(p.stages.decode),
    execute:  formatInstructionForGUI(p.stages.execute),
    memory:   formatInstructionForGUI(p.stages.memory),
    writeBack:formatInstructionForGUI(p.stages.writeBack)
  };
  const perf = p.getPerformanceStats();          // includes hitRate
  // if cache is off, override
  if (!memorySystem.cacheEnabled) perf.hitRate = 0;
  mainWindow.webContents.send('update-state', {
    pipeline: { ...formatted, clockCycle: p.clockCycle },
    registers: registers.getAllRegisters(),
    instructionRegister: instructionReg.read(),
    programCounter: PC.read(),
    instructionQueue: [...instructionQueue],
    memory: memorySystem.getMemorySnapshot?.()||{},
    performance: perf
  });
}

function resetSimulationState() {
  instructionQueue.length = 0;
  PC.write(-1);
  instructionReg.write(0);
  p.clockCycle = 0;
  p.instructionCount = 0;
  p.stallCount = 0;
  p.stages = { fetch: null, decode: null, execute: null, memory: null, writeBack: null };
  for (let i=0;i<32;i++) registers.write(i,0);
  memorySystem.reset?.();
  mainWindow.webContents.send('simulation-reset-complete');
}

// IPC bindings
import { assembleFile } from './assembler.mjs';

ipcMain.on('start-simulation', () => {
  try {
    assembleFile('instructions.txt','instructions.bin');
  } catch(e) {
    return mainWindow.webContents.send('simulation-error', e.message);
  }
  const bin = fs.readFileSync(path.join(__dirname,'instructions.bin'));
  for (let i=0; i<bin.length; i+=4) {
    instructionQueue.push(bin.readUInt32BE(i));
  }
  updateGUI();
  mainWindow.webContents.send('instructions-loaded', instructionQueue.length);
});

ipcMain.on('step-simulation', () => {
  if (p.pipelineEnabled) {
    simulateClockCycle();
  } else {
    runOneInstructionToCompletion();
  }
  updateGUI();
});

ipcMain.on('run-simulation', () => {
  resetPerformanceCounters();
  if (p.pipelineEnabled) {
    // pipelined mode: step one cycle at a time until everything drains
    while (
      instructionQueue.length > 0 ||
      Object.values(p.stages).some(stage => stage !== null) ||
      Object.keys(memorySystem.getPendingRequests()).length > 0
    ) {
      simulateClockCycle();
    }
  } else {
    // serial mode: retire one instruction at a time until queue empty
    while (instructionQueue.length > 0) {
      runOneInstructionToCompletion();
    }
  }

  // final update & "done" event
  updateGUI();
  mainWindow.webContents.send('simulation-complete');
});

ipcMain.on('reset-simulation', resetSimulationState);
ipcMain.on('get-stats',      () => mainWindow.webContents.send('stats-updated', p.getPerformanceStats()));
ipcMain.on('toggle-cache',    (_e,en)=> memorySystem.cacheEnabled = en);
ipcMain.on('toggle-pipeline', (_e,en)=> p.pipelineEnabled = en);

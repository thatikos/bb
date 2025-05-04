// Configuration constants
const wordSizeBytes = 4; // 32 bits
const wordsPerLine = 16;
const cacheSize = 16;
const memorySize = 32768; // 32K words
const memoryDelay = 4; // Memory access delay in cycles
const cacheDelay = 1; // Cache access delay in cycles

class CacheLine {
    constructor() {
        this.tag = -1; 
        this.valid = 0;
        this.data = new Array(wordsPerLine).fill(0);
    }

    updateCacheLine(tag, newData) {
        this.tag = tag;
        this.valid = 1;
        this.data = [...newData];
    }

    isCacheHit(addressTag) {
        return (addressTag === this.tag) && (this.valid === 1);
    }
}

export class Cache {
    constructor() {
        this.cache = new Array(cacheSize).fill().map(() => new CacheLine());
        this.totalMisses = 0;
        this.totalHits = 0;
    }

    getIndex(address) {
        return Math.floor((address / wordsPerLine) % cacheSize);
    }

    getTag(address) {
        return Math.floor(address / (wordsPerLine * cacheSize));
    }

    read(address) {
        const index = this.getIndex(address);
        const tag = this.getTag(address);
        const offset = address % wordsPerLine;
        
        if (this.cache[index].isCacheHit(tag)) {
            this.totalHits++;
            return { hit: true, data: this.cache[index].data[offset] };
        } else {
            this.totalMisses++;
            return { hit: false, index, tag, offset };
        }
    }

    viewLine(lineIndex) {
        if (lineIndex < 0 || lineIndex >= cacheSize) {
            return { error: "Invalid cache line index" };
        }
        return {
            tag: this.cache[lineIndex].valid === 1 ? this.cache[lineIndex].tag : "null",
            valid: this.cache[lineIndex].valid,
            data: [...this.cache[lineIndex].data]
        };
    }
}

export class Memory {
    constructor() {
        this.lines = Math.ceil(memorySize / wordsPerLine);
        this.data = new Array(this.lines).fill().map(() => new Array(wordsPerLine).fill(0));
        this.delay = memoryDelay;
        this.count = 0;
        this.servingStage = null;
        this.pendingOperation = null;
    }

    getLineAndOffset(address) {
        address = Number(address);
        if (address < 0 || address >= memorySize) {
            throw new Error(`Memory address ${address} out of bounds`);
        }
        const lineIndex = Math.floor(address / wordsPerLine);
        const offset = address % wordsPerLine;
        return { lineIndex, offset };
    }

    ensureMemoryLocation(address) {
        const { lineIndex, offset } = this.getLineAndOffset(address);
        
        if (lineIndex >= this.data.length) {
            throw new Error(`Memory line index ${lineIndex} out of bounds`);
        }
        
        if (!this.data[lineIndex]) {
            this.data[lineIndex] = new Array(wordsPerLine).fill(0);
        }
        
        return { lineIndex, offset };
    }

    read(address, stage) {
        const { lineIndex, offset } = this.ensureMemoryLocation(address);
        
        if (this.count > 0) {
            if (stage === this.servingStage) {
                this.count--;
                if (this.count === 0) {
                    const result = { 
                        status: "done", 
                        data: this.data[lineIndex][offset], 
                        line: [...this.data[lineIndex]] 
                    };
                    this.servingStage = null;
                    this.pendingOperation = null;
                    return result;
                }
            }
            return { status: "wait", remainingCycles: this.count };
        } else {
            this.count = this.delay;
            this.servingStage = stage;
            this.pendingOperation = { type: "read", address };
            return { status: "wait", remainingCycles: this.count };
        }
    }
    
    write(address, value, stage) {
        const { lineIndex, offset } = this.ensureMemoryLocation(address);
        
        if (this.count > 0) {
            if (stage === this.servingStage) {
                this.count--;
                if (this.count === 0) {
                    this.data[lineIndex][offset] = value;
                    const result = { status: "done" };
                    this.servingStage = null;
                    this.pendingOperation = null;
                    return result;
                }
            }
            return { status: "wait", remainingCycles: this.count };
        } else {
            this.count = this.delay;
            this.servingStage = stage;
            this.pendingOperation = { type: "write", address, value };
            return { status: "wait", remainingCycles: this.count };
        }
    }

    viewLine(lineIndex) {
        if (lineIndex < 0 || lineIndex >= this.lines) {
            return { error: "Invalid memory line index" };
        }
        return [...this.data[lineIndex]];
    }
}

export class MemorySystem {
    constructor() {
        this.cache = new Cache();
        this.memory = new Memory();
        this.readCount = 0;
        this.writeCount = 0;
        this.cacheHits = () => this.cache.totalHits;
        this.cacheMisses = () => this.cache.totalMisses;
        this.cacheDelay = cacheDelay;
        this.cacheCount = 0;
        this.cacheServingStage = null;
        this.cachePendingOperation = null;
        this.pendingRequests = new Map();
        this.cacheEnabled = true;
    }

    resetStats() {
        this.readCount = 0;
        this.writeCount = 0;
        this.cache.totalHits = 0;
        this.cache.totalMisses = 0;
    }

    reset() {
        this.cache.cache.forEach(cl => {
            cl.valid = 0;
            cl.tag = -1;
            cl.data.fill(0);
        });
        
        for (let i = 0; i < this.memory.data.length; i++) {
            if (this.memory.data[i]) {
                this.memory.data[i].fill(0);
            }
        }
        
        this.pendingRequests.clear();
        this.cacheCount = 0;
        this.cacheServingStage = null;
        this.cachePendingOperation = null;
    }

    processCycle() {
        let progress = false;
        
        for (const [stage, request] of this.pendingRequests.entries()) {
            const result = this.processRequest(request);
            
            if (result.status === "done") {
                this.pendingRequests.delete(stage);
                progress = true;
            }
        }
        
        return progress;
    }
    
    processRequest(request) {
        if (request.type === 'read') {
            return this.processRead(request.address, request.stage);
        } else if (request.type === 'write') {
            return this.processWrite(request.address, request.value, request.stage);
        }
        return { status: 'error', message: 'Unknown request type' };
    }

    read(address, stage) {
        if (!this.cacheEnabled) {
            return this.memory.read(address, stage);
        }

        this.readCount++;
        
        if (this.cacheServingStage !== null && this.cacheServingStage !== stage) {
            return { status: "wait", message: `Cache busy serving stage ${this.cacheServingStage}` };
        }
        
        if (this.pendingRequests.has(stage)) {
            const pendingRequest = this.pendingRequests.get(stage);
            const result = this.processRequest(pendingRequest);
            
            if (result.status === "done") {
                this.pendingRequests.delete(stage);
                return result;
            }
            return { status: "wait", message: `Previous request for stage ${stage} still in progress` };
        }
        
        const cacheResult = this.cache.read(address);
        
        if (cacheResult.hit) {
            if (this.cacheCount === 0) {
                this.cacheCount = this.cacheDelay;
                this.cacheServingStage = stage;
                this.cachePendingOperation = { type: "read", address, hit: true, data: cacheResult.data };
                
                if (this.cacheDelay === 0) {
                    this.cacheServingStage = null;
                    this.cachePendingOperation = null;
                    return { status: "done", data: cacheResult.data, source: "cache" };
                }
                
                this.pendingRequests.set(stage, { type: 'read', address, stage, cacheHit: true });
                return { status: "wait", message: "Cache hit, waiting for delay" };
            } else if (this.cacheServingStage === stage) {
                this.cacheCount--;
                
                if (this.cacheCount === 0) {
                    const result = { 
                        status: "done", 
                        data: this.cachePendingOperation.data, 
                        source: "cache" 
                    };
                    this.cacheServingStage = null;
                    this.cachePendingOperation = null;
                    this.pendingRequests.delete(stage);
                    return result;
                }
                return { status: "wait", remainingCycles: this.cacheCount };
            }
        } else {
            this.pendingRequests.set(stage, { type: 'read', address, stage, cacheHit: false });
            return { status: "wait", message: "Cache miss, waiting for memory" };
        }
        
        return { status: "error", message: "Unexpected state in read operation" };
    }

    processRead(address, stage) {
        const request = this.pendingRequests.get(stage);
        
        if (request.cacheHit) {
            if (this.cacheServingStage === stage) {
                this.cacheCount--;
                if (this.cacheCount === 0) {
                    const cacheResult = this.cache.read(address);
                    this.cacheServingStage = null;
                    return { 
                        status: "done", 
                        data: cacheResult.data, 
                        source: "cache" 
                    };
                }
                return { status: "wait", remainingCycles: this.cacheCount };
            }
        } else {
            const memResult = this.memory.read(address, stage);
            
            if (memResult.status === "done") {
                const index = this.cache.getIndex(address);
                const tag = this.cache.getTag(address);
                this.cache.cache[index].updateCacheLine(tag, memResult.line);
                
                return { 
                    status: "done", 
                    data: memResult.data, 
                    source: "memory",
                    message: `Data loaded from memory: ${memResult.data}`
                };
            } else {
                return { status: "wait", remainingCycles: memResult.remainingCycles };
            }
        }
        
        return { status: "wait", message: "Processing read operation" };
    }

    write(address, value, stage) {
        this.writeCount++;
        
        if (this.cacheServingStage !== null && this.cacheServingStage !== stage) {
            return { status: "wait", message: `Cache busy serving stage ${this.cacheServingStage}` };
        }
        
        if (this.pendingRequests.has(stage)) {
            const pendingRequest = this.pendingRequests.get(stage);
            const result = this.processRequest(pendingRequest);
            
            if (result.status === "done") {
                this.pendingRequests.delete(stage);
                return result;
            }
            return { status: "wait", message: `Previous request for stage ${stage} still in progress` };
        }
        
        const index = this.cache.getIndex(address);
        const tag = this.cache.getTag(address);
        const offset = address % wordsPerLine;
        
        if (this.cache.cache[index].isCacheHit(tag)) {
            this.cache.cache[index].data[offset] = value;
            this.cache.totalHits++;
        } else {
            this.cache.totalMisses++;
        }
        
        this.pendingRequests.set(stage, { type: 'write', address, value, stage });
        return { status: "wait", message: "Memory write queued" };
    }

    processWrite(address, value, stage) {
        const memResult = this.memory.write(address, value, stage);
        
        if (memResult.status === "done") {
            return { 
                status: "done", 
                message: `Write complete: Value ${value} written to address ${address}` 
            };
        } else {
            return { status: "wait", remainingCycles: memResult.remainingCycles };
        }
    }

    viewCache(lineIndex) {
        return this.cache.viewLine(lineIndex);
    }

    viewMemory(lineIndex) {
        return this.memory.viewLine(lineIndex);
    }

    getStats() {
        const totalAccesses = this.cache.totalHits + this.cache.totalMisses;
        return {
            reads: this.readCount,
            writes: this.writeCount,
            cacheHits: this.cache.totalHits,
            cacheMisses: this.cache.totalMisses,
            hitRate: totalAccesses > 0 ? this.cache.totalHits / totalAccesses : 0
        };
    }
    
    getPendingRequests() {
        const pending = {};
        for (const [stage, request] of this.pendingRequests.entries()) {
            pending[stage] = request;
        }
        return pending;
    }

    getMemorySnapshot() {
        const snapshot = {};
        
        // First 64 addresses
        for (let addr = 0; addr < 64; addr++) {
            const { lineIndex, offset } = this.memory.getLineAndOffset(addr);
            snapshot[addr] = this.memory.data[lineIndex][offset];
        }
        
        // Sort array area (100-119)
        for (let addr = 100; addr < 120; addr++) {
            const { lineIndex, offset } = this.memory.getLineAndOffset(addr);
            snapshot[addr] = this.memory.data[lineIndex][offset];
        }
        
        // Matrix areas (200-463)
        for (let addr = 200; addr < 464; addr++) {
            const { lineIndex, offset } = this.memory.getLineAndOffset(addr);
            snapshot[addr] = this.memory.data[lineIndex][offset];
        }
        
        return snapshot;
    }
}

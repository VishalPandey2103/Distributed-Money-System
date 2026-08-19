import { pool } from '../config/db.js';
import * as raftModel from '../models/raftModel.js';

// A thin façade over raftModel that speaks BigInt everywhere and
// hides the fact that log index 0 is a synthetic sentinel (index=0,
// term=0). Every consumer in raft/* reads through this module so we
// only have one place that knows about the sentinel semantics.

export async function getLast() {
    return raftModel.lastLogEntry(pool);
}

export async function getAt(index) {
    return raftModel.logEntryAt(pool, index);
}

export async function getFrom(startIndex, limit) {
    return raftModel.entriesFrom(pool, startIndex, limit);
}

export async function append(db, entry) {
    return raftModel.appendEntry(db, entry);
}

export async function truncateFrom(db, fromIndex) {
    return raftModel.truncateFrom(db, fromIndex);
}

export async function firstIndexInTerm(db, term) {
    return raftModel.firstIndexInTerm(db, term);
}

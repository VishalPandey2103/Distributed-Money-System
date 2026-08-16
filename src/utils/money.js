// All amounts across the system flow as BigInt paise (1 INR = 100 paise).
// Never Number, never float, never string outside the boundary.

const MAX_PAISE = 10n ** 20n - 1n; // matches NUMERIC(20,0)

export function parsePaise(input) {
    if (typeof input === 'bigint') return validate(input);
    if (typeof input === 'number') {
        if (!Number.isSafeInteger(input)) {
            throw new RangeError(`amount ${input} exceeds safe integer range`);
        }
        return validate(BigInt(input));
    }
    if (typeof input === 'string') {
        if (!/^-?\d+$/.test(input)) {
            throw new TypeError(`amount "${input}" is not an integer paise string`);
        }
        return validate(BigInt(input));
    }
    throw new TypeError(`amount has unsupported type ${typeof input}`);
}

function validate(v) {
    if (v > MAX_PAISE || v < -MAX_PAISE) {
        throw new RangeError(`amount exceeds NUMERIC(20,0) range`);
    }
    return v;
}

export function formatRupees(paise) {
    const p = typeof paise === 'bigint' ? paise : BigInt(paise);
    const neg = p < 0n;
    const abs = neg ? -p : p;
    const whole = abs / 100n;
    const frac = (abs % 100n).toString().padStart(2, '0');
    return `${neg ? '-' : ''}${whole}.${frac}`;
}

export function bigintReplacer(_key, value) {
    return typeof value === 'bigint' ? value.toString() : value;
}

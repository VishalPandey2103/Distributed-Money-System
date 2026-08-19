import path from 'node:path';
import { fileURLToPath } from 'node:url';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(__dirname, '..', 'proto', 'raft.proto');

const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String, // int64 as JS string — safer than Number
    enums: String,
    defaults: true,
    oneofs: true,
});
const grpcObj = grpc.loadPackageDefinition(pkgDef);
export const RaftProto = grpcObj.raft.Raft;

// ---------------- Client ----------------

// One persistent client per peer. gRPC-js multiplexes calls onto one HTTP/2
// connection, so we don't need pooling.
export function makePeerClient(grpcAddr) {
    return new RaftProto(grpcAddr, grpc.credentials.createInsecure(), {
        'grpc.keepalive_time_ms': 20000,
        'grpc.keepalive_timeout_ms': 5000,
    });
}

// Wrap a callback-style unary call as a Promise with a deadline. If the
// deadline is exceeded, the promise rejects with a DEADLINE_EXCEEDED
// error — leader treats that identically to a failed reply.
export function callUnary(client, method, req, deadlineMs) {
    return new Promise((resolve, reject) => {
        const deadline = new Date(Date.now() + deadlineMs);
        client[method](req, { deadline }, (err, response) => {
            if (err) return reject(err);
            resolve(response);
        });
    });
}

// ---------------- Server ----------------

export function startGrpcServer({ port, handlers }) {
    const server = new grpc.Server();
    server.addService(RaftProto.service, {
        RequestVote:   (call, cb) => wrap(cb, () => handlers.requestVote(call.request)),
        AppendEntries: (call, cb) => wrap(cb, () => handlers.appendEntries(call.request)),
    });
    return new Promise((resolve, reject) => {
        server.bindAsync(
            `0.0.0.0:${port}`,
            grpc.ServerCredentials.createInsecure(),
            (err, actualPort) => {
                if (err) return reject(err);
                resolve({ server, port: actualPort });
            }
        );
    });
}

async function wrap(cb, fn) {
    try {
        const res = await fn();
        cb(null, res);
    } catch (err) {
        cb({ code: grpc.status.INTERNAL, message: err.message });
    }
}

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.findNextRemotea = findNextRemotea;
exports.forwardUnknownVerb = forwardUnknownVerb;
exports.unknownVerbMessage = unknownVerbMessage;
exports.defaultForwardDeps = defaultForwardDeps;
/**
 * The desktop CLI's half of one `remotea` command (verbs.ts): a verb it does
 * not know goes to the next `remotea` on PATH, which in a WSL pane is the
 * host's admin CLI. This install's own shims are skipped, by folder and by
 * their marker line, so the CLI never hands a verb back to itself.
 *
 * Only on POSIX: a host CLI is a Linux program, and a Windows shell has none.
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const verbs_1 = require("./verbs");
/** The next `remotea` on PATH that is not one of ours, or null. */
function findNextRemotea(deps) {
    if (deps.platform === 'win32')
        return null;
    const own = new Set(deps.ownDirs.map((d) => path_1.default.resolve(d)));
    for (const dir of (deps.env.PATH ?? '').split(path_1.default.delimiter)) {
        if (!dir || own.has(path_1.default.resolve(dir)))
            continue;
        const candidate = path_1.default.join(dir, 'remotea');
        if (!deps.isFile(candidate))
            continue;
        if (deps.readHead(candidate).includes(verbs_1.SHIM_MARKER))
            continue;
        return candidate;
    }
    return null;
}
/**
 * Hand `args` to the next `remotea`. Returns its exit code, or null when the
 * call was already handed over once or there is nowhere to send it.
 */
function forwardUnknownVerb(args, deps) {
    if (deps.env[verbs_1.FORWARDED_ENV] === '1')
        return null;
    const next = findNextRemotea(deps);
    if (!next)
        return null;
    return deps.run(next, args, { ...deps.env, [verbs_1.FORWARDED_ENV]: '1' });
}
/** What the desktop CLI says about a verb neither program took. */
function unknownVerbMessage(verb) {
    return `Unknown command: ${verb}\n`
        + 'This is the desktop remotea, which drives the app from inside its terminals. '
        + 'Host commands (status, doctor, upgrade, hooks, …) belong to the host\'s remotea: '
        + 'run them on the host, where `remotea --help` lists them.';
}
/** The real deps, for a CLI file at `cliDir` (resources/cli or dist/cli). */
function defaultForwardDeps(cliDir) {
    return {
        env: process.env,
        platform: process.platform,
        ownDirs: [path_1.default.resolve(cliDir, '../cli-bin'), path_1.default.resolve(cliDir, '../../src/cli-bin')],
        isFile: (p) => {
            try {
                return fs_1.default.statSync(p).isFile();
            }
            catch {
                return false;
            }
        },
        readHead: (p) => {
            try {
                const fd = fs_1.default.openSync(p, 'r');
                try {
                    const buf = Buffer.alloc(512);
                    const n = fs_1.default.readSync(fd, buf, 0, buf.length, 0);
                    return buf.subarray(0, n).toString('utf-8');
                }
                finally {
                    fs_1.default.closeSync(fd);
                }
            }
            catch {
                return '';
            }
        },
        run: (file, args, env) => {
            const r = (0, child_process_1.spawnSync)(file, args, { stdio: 'inherit', env });
            return r.status ?? 1;
        },
    };
}

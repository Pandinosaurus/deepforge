const {spawn} = require('child_process');
const WebSocket = require('ws');
const fs = require('fs');
const fsp = require('fs').promises;
const { promisify } = require('util');
const pipeline = promisify(require('stream').pipeline);
const path = require('path');
const requirejs = require('requirejs');
let Message;

class InteractiveClient {
    constructor(id, host) {
        this.id = id;
        this.host = host;
        this.ws = null;
        this.sessions = {};
    }

    connect() {
        this.ws = new WebSocket(this.host);
        this.ws.on('open', () => this.ws.send(this.id));
        this.ws.on('message', data => this.onMessage(Message.decode(data)));
    }

    async onMessage(msg) {
        const {sessionID} = msg;
        if (!this.sessions[sessionID]) {
            this.sessions[sessionID] = new InteractiveSession(sessionID, this.ws);
        }

        await this.sessions[sessionID].onMessage(msg);
        if (this.sessions[sessionID].activeMsgCount === 0) {
            delete this.sessions[sessionID];
        }
    }
}

class InteractiveSession {
    constructor(sessionID, ws) {
        this.ws = ws;
        this.sessionID = sessionID;
        this.activeMsgCount = 0;
    }

    async sendMessage(type, data) {
        this.ws.send(Message.encode(this.sessionID, type, data));
    }

    async onTaskComplete() {
        const data = [...arguments];
        this.sendMessage(Message.COMPLETE, data);
        this.activeMsgCount--;
    }

    async onMessage(msg) {
        this.activeMsgCount++;
        if (msg.type === Message.RUN) {
            const [cmd, ...opts] = InteractiveSession.parseCommand(msg.data);
            this.subprocess = spawn(cmd, opts);
            this.subprocess.on('exit', code => this.onTaskComplete(code));
            this.subprocess.stdout.on('data', data => this.sendMessage(Message.STDOUT, data));
            this.subprocess.stderr.on('data', data => this.sendMessage(Message.STDERR, data));
        } else if (msg.type === Message.KILL) {
            if (this.subprocess) {  // TODO: Add more checking here...
                this.subprocess.kill();
            }
        } else if (msg.type === Message.ADD_ARTIFACT) {
            const [name, dataInfo, type, config={}] = msg.data;
            const dirs = ['artifacts', name];
            await mkdirp(...dirs);
            const Storage = await getStorageAdapters();
            const fetchArtifact = async () => {
                const client = await Storage.getClient(dataInfo.backend, undefined, config);
                const dataPath = path.join(...dirs.concat('data'));
                const stream = await client.getFileStream(dataInfo);
                await pipeline(stream, fs.createWriteStream(dataPath));
                const filePath = path.join(...dirs.concat('__init__.py'));
                await fsp.writeFile(filePath, initFile(name, type));
            };

            await this.runTask(fetchArtifact);
        } else if (msg.type === Message.SAVE_ARTIFACT) {
            const [filepath, name, backend, config={}] = msg.data;
            const Storage = await getStorageAdapters();
            const saveArtifact = async () => {
                const client = await Storage.getClient(backend, null, config);
                const stream = await fs.createReadStream(filepath);
                const dataInfo = await client.putFileStream(name, stream);
                return dataInfo;
            };

            await this.runTask(saveArtifact);
        } else if (msg.type === Message.ADD_FILE) {
            await this.runTask(() => {
                const [filepath, content] = msg.data;
                this.ensureValidPath(filepath);
                this.writeFile(filepath, content);
            });
        } else if (msg.type === Message.SET_ENV) {
            await this.runTask(() => {
                const [name, value] = msg.data;
                process.env[name] = value;
            });
        } else if (msg.type === Message.REMOVE_FILE) {
            await this.runTask(async () => {
                const [filepath] = msg.data;
                this.ensureValidPath(filepath);
                await fsp.unlink(filepath);
            });
        } else {
            this.onTaskComplete(2);
        }
    }

    ensureValidPath(filepath) {
        const isOutsideWorkspace = path.relative(
            path.resolve(__dirname),
            path.resolve(filepath)
        ).startsWith('..');

        if (isOutsideWorkspace) {
            throw new Error('Cannot edit files outside workspace: ' + filepath);
        }
    }

    async writeFile(filepath, content) {
        const dirs = path.dirname(filepath).split(path.sep);
        await mkdirp(...dirs);
        await fsp.writeFile(filepath, content);
    }

    async runTask(fn) {
        let exitCode = 0;
        let result;
        try {
            result = await fn();
        } catch (err) {
            exitCode = 1;
            console.log('Task failed with error:', err);
        }
        this.onTaskComplete(exitCode, result);
    }

    static parseCommand(cmd) {
        const chunks = [''];
        let quoteChar = null;
        for (let i = 0; i < cmd.length; i++) {
            const letter = cmd[i];
            const isQuoteChar = letter === '"' || letter === '\'';
            const isInQuotes = !!quoteChar;
            if (!isInQuotes && isQuoteChar) {
                quoteChar = letter;
            } else if (quoteChar === letter) {
                quoteChar = null;
            } else {
                const isNewChunk = letter === ' ' && !isInQuotes;
                if (isNewChunk) {
                    chunks.push('');
                } else {
                    const lastChunk = chunks[chunks.length - 1];
                    chunks[chunks.length - 1] = lastChunk + letter;
                }
            }
        }
        return chunks;
    }
}

async function getStorageAdapters() {
    return new Promise((resolve, reject) => {
        requirejs([
            './utils.build',
        ], (
            Utils,
        ) => {
            const {Storage} = Utils;
            resolve(Storage);
        }, reject);
    });
}

async function mkdirp() {
    const dirs = Array.prototype.slice.call(arguments);
    await dirs.reduce(async (lastDirPromise, nextDir) => {
        const dir = path.join(await lastDirPromise, nextDir);
        try {
            await fsp.mkdir(dir);
        } catch (err) {
            if (err.code !== 'EEXIST') {
                throw err;
            }
        }
        return dir;
    }, process.cwd());
}

function initFile(name, type) {
    const dataPathCode = `path.join(path.dirname(__file__), 'data')`;
    return [
        'import deepforge',
        'from os import path',
        `name = '${name}'`,
        `type = '${type}'`,
        `data = deepforge.serialization.load('${type}', open(${dataPathCode}, 'rb'))`
    ].join('\n');
}

module.exports = {InteractiveClient, InteractiveSession};

const isImportedModule = require.main !== module;
if (!isImportedModule) {
    Message = require('./message');
    const [, , SERVER_URL, ID] = process.argv;
    const client = new InteractiveClient(ID, SERVER_URL);
    client.connect();
}

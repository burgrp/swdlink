const { spawn } = require("child_process");
const net = require("net");

module.exports = async config => {

    async function exec(command, ...params) {

        let stdin;

        if (params[0] instanceof Array) {
            stdin = params[1];
            params = params[0];
        }

        return new Promise((resolve, reject) => {

            const spawned = spawn(command, params, { stdio: ["pipe", "pipe", "pipe"] });

            let out = "";
            let err = "";

            spawned.stdout.on("data", data => {
                out = out + data.toString();
            });

            spawned.stderr.on("data", data => {
                err = err + data.toString();
            });

            spawned.on("close", code => {
                if (code === 0) {
                    resolve(out);
                } else {
                    let error = new Error(err.trim());
                    error.code = code;
                    reject(error);
                }
            });

            if (stdin !== undefined) {
                spawned.stdin.write(stdin);
                spawned.stdin.end();
            }

        });
    }

    if (!config.elf) {
        throw new Error("ELF file not specified");
    }

    let symbols = (await exec("objdump", "-t", config.elf))
        .split("\n")
        .map(l => l.match(/^(?<addr16>[0-9a-f]+) .* (?<name>[\w._$]+)$/))
        .filter(m => m)
        .reduce((acc, m) => ({
            [m.groups.name]: parseInt("0x" + m.groups.addr16),
            ...acc
        }), {});

    let telnetPort = config.ports && config.ports.telnet || 4444;

    let params = [
        "--command", `gdb_port ${config.ports && config.ports.gdb || 3333}`,
        "--command", `tcl_port ${config.ports && config.ports.tcl || "disabled"}`,
        "--command", `telnet_port ${telnetPort}`,
        ...config.tcl.map(f => ["--file", f]).flatMap(f => f)
    ];

    let openocd;
    let closedIntentionally = false;

    function startOpenocd() {
        openocd = spawn("openocd", params);

        function checkError(chunk) {
            if (chunk.toString().indexOf("Error: ") > -1) {
                openocd.kill();
            }
        }

        openocd.stdout.on("data", chunk => {
            checkError(chunk);
            process.stdout.write(chunk);
        });

        openocd.stderr.on("data", chunk => {
            checkError(chunk);
            process.stderr.write(chunk);
        });

        openocd.on("close", code => {
            console.info("openocd closed ", code);
            if (!closedIntentionally) {
                setTimeout(() => {
                    console.info("Restarting openocd");
                    startOpenocd();
                }, 500);
            }
        });
    }

    startOpenocd();

    let socket;

    let waiting = [];
    let pending;
    let buffer = "";

    function checkWaiting() {
        if (!pending && !socket.pending) {
            pending = waiting.shift();
            if (pending) {
                socket.write(pending.command + "\n");
            }
        }
    }

    function connectTelnet() {
        socket = new net.Socket();
        socket.connect(telnetPort);

        socket.on("connect", () => {
            checkWaiting();
        });

        socket.on("data", chunk => {

            buffer = buffer + chunk.toString().replace(/\r/g, "");

            let reset = buffer.indexOf("\u0000");

            if (reset !== -1) {
                buffer = buffer.substring(reset + 1);
            }

            if (pending && buffer.endsWith("> ")) {

                let reply = buffer.substring(0, buffer.length - 2);

                buffer = "";
                pending.resolve(reply);
                pending = undefined;
                checkWaiting();
            }

        });

        socket.on("error", error => {
            console.error("Telnet socket error:", error);
        });

        socket.on("close", () => {
            console.info("Telnet socket closed");
            socket = undefined;
            if (!closedIntentionally) {
                setTimeout(() => {
                    console.info("Reconnecting to telnet");
                    connectTelnet();
                }, 500);
            }
        });
    }

    connectTelnet();

    function command(command, timeoutMs = 5000) {
        return new Promise((resolve, reject) => {

            let timeoutObj;

            let p = {
                command,
                resolve: function (result) {
                    clearTimeout(timeoutObj);
                    resolve(result);
                },
                reject
            };

            waiting.push(p);
            checkWaiting();

            timeoutObj = setTimeout(() => {

                if (pending === p) {
                    pending = undefined;
                }
                waiting = waiting.filter(i => i !== p);
                checkWaiting();

                reject(new Error("Command timed out"));
            }, timeoutMs);

        });
    }

    function parseResult(str, regex) {
        let match = str.match(regex);
        if (!match) {
            throw new Error(str.trim());
        }
        return match.groups.result;
    }

    function parseSingleValue(str, radix = 16) {
        return parseInt(parseResult(str, /^0x[0-9a-z]+: (?<result>[0-9a-z]+)[^\w]*$/), radix);
    }

    function resolveAddress(address) {
        if (typeof address === "string") {
            let symbol = address;
            address = symbols[symbol];
            if (address === undefined) {
                throw new Error(`Unknown symbol "${symbol}"`);
            }
        }
        return address;
    }

    return {
        symbols,

        close() {
            closedIntentionally = true;
            openocd.kill();
        },

        command,

        async read32(address, timeoutMs) {
            return parseSingleValue(await command(`mdw ${resolveAddress(address)}`, timeoutMs));
        },

        async read16(address, timeoutMs) {
            return parseSingleValue(await command(`mdh ${resolveAddress(address)}`, timeoutMs));
        },

        async read8(address, timeoutMs) {
            return parseSingleValue(await command(`mdb ${resolveAddress(address)}`, timeoutMs));
        },

        async read(address, length, timeoutMs) {
            let result = await command(`mdb ${resolveAddress(address)} ${length}`, timeoutMs);
            return Buffer.from(
                result
                    .split("\n")
                    .map(l => l.trim().match(/^0x[0-9a-z]+: (?<result>[0-9a-z ]+)[^\w]*$/))
                    .filter(l => l)
                    .map(m => m.groups.result)
                    .join("")
                    .replace(/ /g, ""), "hex");
        },

        async write32(address, value, timeoutMs) {
            await command(`mww ${resolveAddress(address)} ${value}`, timeoutMs);
        },

        async write16(address, value, timeoutMs) {
            await command(`mwh ${resolveAddress(address)} ${value}`, timeoutMs);
        },

        async write8(address, value, timeoutMs) {
            await command(`mwb ${resolveAddress(address)} ${value}`, timeoutMs);
        },

        async flash(timeoutMs) {
            await command("reset halt", timeoutMs);
            await command(`load_image ${config.elf}`, timeoutMs);
            await command("resume", timeoutMs);
        },

        async reset(timeoutMs) {
            await command("reset", timeoutMs);
        }
    }

}
const { spawn } = require("child_process");

module.exports = async config => {

    async function exec(command, ...params) {

        let stdin;

        if (params[0] instanceof Array) {
            stdin = params[1];
            params = params[0];
        }

        //console.info("#", command, ...params);

        return new Promise((resolve, reject) => {

            const spawned = spawn(command, params, { stdio: ["pipe", "pipe", "pipe"] });

            let out = "";
            let err = "";

            spawned.stdout.on("data", data => {
                //process.stdout.write(data);
                out = out + data.toString();
            });

            spawned.stderr.on("data", data => {
                //process.stderr.write(data);
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


    let params = [
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

    return {
        symbols,
        close() {
            closedIntentionally = true;
            openocd.kill();
        }
    }

}
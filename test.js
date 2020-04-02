require("@device.farm/appglue")({ require, file: __dirname + "/config.json" }).main(async ({ mcu }) => {
    await mcu.reset();
    console.info("LED:", await mcu.read32("led"));
    console.info("A0:", await mcu.read("led", 100));
});
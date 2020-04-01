require("@device.farm/appglue")({require, file: __dirname + "/config.json"}).main(config => {
    console.info(config.mcu.symbols.led);

    //setTimeout(() => config.mcu.close(), 3000);
    
});
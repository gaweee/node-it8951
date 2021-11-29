# node-it8951
This is a port of the IT8951-ePaper [C driver from Waveshare](https://github.com/waveshare/IT8951-ePaper) combined with some concepts from the [Python PaperTTY IT8951 Driver](https://github.com/joukos/PaperTTY/blob/3ea8286903b98fac071285008b4cc05dd84c2121/papertty/drivers/driver_it8951.py)

Key features of this library:
* Fast, uses native GPIO libraries
* Auto VCOM Detection
* Supports 1,2,4 Bits Per Pixel (BPP)
* Remappable Pins
* Configurable Buffer Size, if you intend to change your [SPI buffer size](https://forums.raspberrypi.com/viewtopic.php?f=44&t=124472)

**Important Information For 1BPP Drawing**
For 1BPP mode (black/white), some devices (E.g. Waveshare 6" HD E-Paper) have to turn on 4-byte align which forces the drawing of X and Width setting to be factors of 32.   
Additionally, we still need to, depite the 1BPP definition, we would still have to provide 8-bit buffers (as a known workaround).  
For the devices that support higher BPP, I would certainly recommend using those since you neither gain the fidelity nor the performance of using 1BPP.  
See: https://www.waveshare.com/wiki/Template:EPaper_Codes_Descriptions-IT8951  


## In-Action Shot
![Action Shot](https://i.postimg.cc/bwyHScRc/it8951.png)

## Dependencies
1. [GPIO](https://github.com/jperkin/node-rpio)

## Getting Started
  ```sh
  npm install node-it8951
  ```

## Example Code
```js
    const IT8951 = require('node-it8951');

    const display = new IT8951({ MAX_BUFFER_SIZE: 32797, ALIGN4BYTES: true });
    display.init();
    display.wait(2000);
    sample4BPP(display);
    display.wait(2000);
    display.clear();
    sample2BPP(display);
    display.wait(2000);
    display.clear();
    sample1BPP(display);
    display.wait(2000);
    display.clear();
    display.close();



    function sample4BPP(display) {
        display.config.BPP = 4; // BPP4
        const colors = [0xFF,0xEE,0xDD,0xCC,0xBB,0xAA,0x99,0x88,0x77,0x66,0x55,0x44,0x33,0x22,0x11,0x00];
        const segmentHeight = Math.trunc(display.height/colors.length);

        for (let i=0; i<colors.length; i++) {
            const buffer = Buffer.alloc(display.width * segmentHeight * display.config.BPP / 8, colors[i]);
            display.draw(buffer, 0, segmentHeight * i, display.width, segmentHeight);
        }
    }

    function sample2BPP(display) {
        display.config.BPP = 2;
        const hwidth = display.width/2;
        const hheight = display.height/2;
        const colors = [0xFF, 0xAA, 0x55, 0x00];
        for (let i=0; i<colors.length; i++) {
            const buffer = Buffer.alloc(hwidth * hheight * display.config.BPP / 8, colors[i]);
            display.draw(buffer, i%2 * hwidth, Math.trunc(i/2) * hheight, hwidth, hheight);
        }
    }

    function sample1BPP(display) {
        display.config.BPP = 1;
        const hwidth = display.width/2;
        const colors = [0xFF, 0x00];
        const buffer = Buffer.alloc(roundTo32(display.width/2) * display.height, 0x00);
        display.draw(buffer, 0, 0, roundTo32(display.width/2), display.height);
        display.config.BPP = 4;
    }


    function roundTo32(v) {
        return v = v - (v % 32);
    }
```

## Functions Calls
`IT8951(config)`
Constructor that takes in a suite of parameters
```js
    const config = {
        MAX_BUFFER_SIZE: 4096, // Can be changed to 32786 for example
        PINS: {
            RST: 11, // 17 BCM
            CS: 24, // 8 BCM
            BUSY: 18, // 24 BCM
        },
        VCOM: 2150, // Supports autodetection so if this is wrong, it will fix that for you
        BPP: 4, // Rendering BPP (can be changed as required before each draw or display call). Valid values are 1, 2, 4
        ALIGN4BYTES: false, // Use to support BPP1 situations for some specific Waveshare devices
        SWAP_BUFFER_ENDIANESS: true, // Repacks the buffer to Llittle Endian format
    };
```

`IT8951.init()`  
Runs the initialization sequence (Required).  

`IT8951.draw(buffer, x, y, w, h, display_mode)`  
Transfers the buffers to the device and refreshes the screen to the specific coordinates and dimensions.  
Optional display_mode can be forwarded to `displayArea` call. Only call this if you are familiar with your device settings:  
* DISPLAY_UPDATE_MODE_INIT = 0, A fast non-flashy update mode that can go from any gray scale color to black or white.
* DISPLAY_UPDATE_MODE_GC16 = 2, For more documentation on display update modes see the reference document= http=//www.waveshare.net/w/upload/c/c4/E-paper-mode-declaration.pdf
* DISPLAY_UPDATE_MODE_A2 = 6, A flashy update mode that can go from any gray scale color to any other gray scale color.


`IT8951.displayArea(x, y, w, h, display_mode)`  
Internal method used to repaint the display's based on the specific coordinates and dimensions.  

`IT8951.clear(color=0xFF, display_mode)`  
Flushes the screen to white, optionally send 0x00 for black.  

`IT8951.wait()`  
GPIO delay before the next event.  

`IT8951.activate()`  
Sets up the device, enable all clocks and go to active state. Already run as part of `init` sequence.  

`IT8951.reset()`  
Resets the display, Already run as part of `init` sequence.  

`IT8951.standby()`  
Gates of all clocks and goes into a standby state.  

`IT8951.sleep()`  
Disable all clocks and go to sleep. Already run as part of `close` sequence.  

`IT8951.close()`  
Shutsdown the driver and releases control of the GPIO and SPI pins.  


## TODO
* Test driver on other IT8951 Devces  
* Support Rotation  


## Other Resources
* [C driver from Waveshare](https://github.com/waveshare/IT8951-ePaper)
* [Python PaperTTY IT8951 Driver](https://github.com/joukos/PaperTTY/blob/3ea8286903b98fac071285008b4cc05dd84c2121/papertty/drivers/driver_it8951.py)
* [IT8951 Specifications Document](https://www.waveshare.net/w/upload/1/18/IT8951_D_V0.2.4.3_20170728.pdf)
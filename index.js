const rpio = require('rpio');
const struct = require('python-struct');

const ROTATE0= 0;
const ROTATE90= 1;
const ROTATE180= 2;
const ROTATE270= 3;

const ENDIAN_LITTLE = 0;
const ENDIAN_BIG = 1;

const DISPLAY_UPDATE_MODE_INIT= 0; // A fast non-flashy update mode that can go from any gray scale color to black or white.
const DISPLAY_UPDATE_MODE_GC16= 2; // For more documentation on display update modes see the reference document= http=//www.waveshare.net/w/upload/c/c4/E-paper-mode-declaration.pdf
let DISPLAY_UPDATE_MODE_A2= 6; // A flashy update mode that can go from any gray scale color to any other gray scale color.

const CMD_SYS_RUN = 0x0001;
const CMD_GET_DEVICE_INFO = 0x0302;
const CMD_READ_REGISTER = 0x0010;
const CMD_WRITE_REGISTER = 0x0011;
const CMD_DISPLAY_AREA = 0x0034
const CMD_DISPLAY_AREA_BUFFER = 0x0037;
const CMD_VCOM = 0x0039;
const CMD_LOAD_IMAGE_AREA = 0x0021;
const CMD_LOAD_IMAGE_END = 0x0022;
const CMD_STANDBY = 0x0002;
const CMD_SLEEP = 0x0003;

const REG_SYSTEM_BASE = 0;
const REG_I80CPCR = REG_SYSTEM_BASE + 0x04;
const REG_DISPLAY_BASE = 0x1000;
const REG_LUTAFSR = REG_DISPLAY_BASE + 0x224; // LUT Status Reg (status of All LUT Engines)
const REG_MEMORY_CONV_BASE_ADDR = 0x0200;
const REG_MEMORY_CONV = REG_MEMORY_CONV_BASE_ADDR + 0x0000;
const REG_MEMORY_CONV_LISAR = REG_MEMORY_CONV_BASE_ADDR + 0x0008;

//Update Parameter Setting Register
const DISPLAY_REG_BASE = 0x1000 ;
const UP0SR = DISPLAY_REG_BASE + 0x134;  //Update Parameter0 Setting Reg
const UP1SR = DISPLAY_REG_BASE + 0x138;  //Update Parameter1 Setting Reg
const LUT0ABFRV = DISPLAY_REG_BASE + 0x13C;  //LUT0 Alpha blend and Fill rectangle Value
const UPBBADDR = DISPLAY_REG_BASE + 0x17C;  //Update Buffer Base Address
const LUT0IMXY = DISPLAY_REG_BASE + 0x180;  //LUT0 Image buffer X/Y offset Reg
const LUTAFSR = DISPLAY_REG_BASE + 0x224;  //LUT Status Reg (status of All LUT Engines)
const BGVR = DISPLAY_REG_BASE + 0x250;  //Bitmap (1bpp) image color table


/**
 * A generic driver for displays that use a IT8951 controller board.
 * This class will automatically infer the width and height by querying the
 * controller.
 **/

const CONFIG = {
    MAX_BUFFER_SIZE: 4096, // Can be changed to 32786 for example
    PINS: {
        RST: 11, // 17 BCM
        CS: 24, // 8 BCM
        BUSY: 18, // 24 BCM
    },
    VCOM: 2150, // Supports autodetection so if this is wrong, it will fix that for you
    BPP: 4, // Rendering BPP (can be changed as required before each draw or display call)
    ALIGN4BYTES: false, // Use to support BPP1 situations for some specific Waveshare devices
    ROTATION: ROTATE0 // Not yet in use
};

class IT8951 {

    constructor(options = {}) {
        this.config = { ...CONFIG, ...options };
        
        // Overrides for potentially other devices
        if (this.config.MODE_A2) DISPLAY_UPDATE_MODE_A2 = this.config.MODE_A2;
    }

    init() {
        this.gpio = rpio;
        this.gpio.init({ mapping: 'physical', gpiomem: false });
        
        this.gpio.spiBegin();
        this.gpio.spiSetClockDivider(32);
        
        this.gpio.open(this.config.PINS.CS, this.gpio.OUTPUT);
        this.gpio.open(this.config.PINS.RST, this.gpio.OUTPUT, this.gpio.HIGH);
        this.gpio.open(this.config.PINS.BUSY, this.gpio.INPUT, this.gpio.PULL_DOWN);
        
        this.reset();
        this.activate();
        this.wait_for_ready();

        // Get Device Info here
        this.write_command(CMD_GET_DEVICE_INFO);
        let device_info = this.read_data(40);
        
        let [
            width,
            height,
            img_addr_l,
            img_addr_h,
            firmware_version,
            lut_version,
        ] = struct.unpack(">HHHH16s16s", device_info);
        
        this.width = width;
        this.height = height;
        this.img_addr = (img_addr_h << 16) | img_addr_l;
        
        console.log("width = ", this.width);
        console.log("height = ", this.height);
        console.log("img_addr = ", this.img_addr.toString(16));
        console.log("firmware = ", fixString(firmware_version));
        console.log("lut = ", fixString(lut_version));

        // Set to Enable I80 Packed mode.
        this.write_register(REG_I80CPCR, 0x0001);

        if (this.VCOM != this.get_vcom()) {
            this.set_vcom(this.config.VCOM);
            console.log("VCOM = ", (this.get_vcom() / 1000.0 * -1), 'v');
        }

        // Initialize the display with a blank image.
        this.wait_for_ready();
        this.clear(0xFF, DISPLAY_UPDATE_MODE_INIT);
    }


    /** I/O Functions ****************************************************************************************************************************** */
    
    // Expects a buffer of bytes
    spi_write(data) {
        const tx = Buffer.from(data);
        this.gpio.spiWrite(tx, tx.length);
    }

    spi_read(n) {
        const tx = Buffer.alloc(n, 0x00);
        const rx = Buffer.alloc(n);
        
        this.gpio.spiTransfer(tx, rx, tx.length);
        return rx;
    }

    // Expects 2byte inputs that will be converted into a Buffer (byte stream)
    write_command(cmd, params = []) {
        const preamble = 0x6000;

        this.wait_for_ready();
        this.gpio.write(this.config.PINS.CS, this.gpio.LOW);
        this.spi_write(bytesFrom16(preamble))
        this.wait_for_ready();
        this.spi_write(bytesFrom16(cmd));
        this.gpio.write(this.config.PINS.CS, this.gpio.HIGH);

        if (params) {
            for (const param of params) this.write_data(bytesFrom16(param));
        }
    }

    // Expects data of array of bytes
    write_data(data) {
        const preamble = 0x0000;
        
        this.wait_for_ready();
        this.gpio.write(this.config.PINS.CS, this.gpio.LOW);
        this.spi_write(bytesFrom16(preamble));
        this.wait_for_ready();
        
        for (let i=0; i<data.length; i+=this.config.MAX_BUFFER_SIZE) {
            let chunk = data.slice(i, i + this.config.MAX_BUFFER_SIZE);
            this.spi_write(chunk);
        }
        this.gpio.write(this.config.PINS.CS, this.gpio.HIGH);
    }

    read_data(n) {
        const preamble = 0x1000;
        
        this.wait_for_ready();
        this.gpio.write(this.config.PINS.CS, this.gpio.LOW);
        this.spi_write(bytesFrom16(preamble));
        this.wait_for_ready();

        this.spi_read(2); // Dummy
        this.wait_for_ready();

        let result = this.spi_read(n);
        this.wait_for_ready();
        this.gpio.write(this.config.PINS.CS, this.gpio.HIGH);
        return result;
    }

    // takes 16-bit address and values
    write_register(address, value) {
        this.write_command(CMD_WRITE_REGISTER);
        this.write_data(bytesFrom16(address));
        this.write_data(bytesFrom16(value));
    }

    read_register(address) {
        this.write_command(CMD_READ_REGISTER);
        this.write_data(bytesFrom16(address));
        return bytesTo16(this.read_data(2));
    }

    wait_for_ready() {
        /**
         * Waits for the busy pin to drop.
         * When the busy pin is high the controller is busy and may drop any
         * commands that are sent to it.
         **/
        while (this.gpio.read(this.config.PINS.BUSY) == 0)
			this.gpio.msleep(100);
    }

    wait_for_display_ready() {
        /**
         * Waits for the display to be finished updating.
         * It is possible for the controller to be ready for more commands but the
         * display to still be refreshing. This will wait for the display to be stable. 
         **/
        while (this.read_register(REG_LUTAFSR) != 0)
            this.wait(100);
    }

    /** High Level Commands & Rendering ****************************************************************************************************************************** */

    get_vcom() {
        this.wait_for_ready();
        this.write_command(CMD_VCOM, [0]);
        return bytesTo16(this.read_data(2));
    }

    set_vcom(vcom) {
        this.write_command(CMD_VCOM, [1, vcom]);
    }

    display_area(x, y, w, h, display_mode) {
        const params = [x, y, w, h, display_mode, (this.img_addr & 0xFFFF), ((this.img_addr >> 16) & 0xFFFF)];
        this.write_command(CMD_DISPLAY_AREA_BUFFER, params);
    }

    draw(buffer, x, y, w, h, display_mode = false) {
        this.wait_for_display_ready();
        if (!w) w = this.width;
        if (!h) h = this.height;

        // Workaround for the stupid 4-byte alignment found in https://www.waveshare.com/wiki/Template:EPaper_Codes_Descriptions-IT8951
        if (this.config.ALIGN4BYTES) { 
            x = roundTo32(x);
            w = roundTo32(w);
        }

        this.write_register(REG_MEMORY_CONV_LISAR + 2, (this.img_addr >> 16) & 0xFFFF); // One time shifting of img_addr 32 bit to 2 x 16 bits
        this.write_register(REG_MEMORY_CONV_LISAR, this.img_addr & 0xFFFF);

        // // Define the region being loaded.
        const params = [((ENDIAN_LITTLE << 8) | (mapBPP(this.config.BPP) << 4) | this.config.ROTATION), x, y, w, h];
        this.write_command(CMD_LOAD_IMAGE_AREA, params);
        this.write_data(buffer);
        this.write_command(CMD_LOAD_IMAGE_END);

        let update_mode = (this.config.BPP === 1) ? DISPLAY_UPDATE_MODE_A2 : DISPLAY_UPDATE_MODE_GC16;
        if (display_mode !== false) update_mode = display_mode;
        
        if (this.config.BPP === 1) {
            this.write_register(UP1SR+2, this.read_register(UP1SR+2) | (1<<2));
            this.write_register(BGVR, (0x00 << 8) | 0xF0);
        }

        // Release display area buffer
        this.display_area(x, y, w, h, update_mode);

        if (this.config.BPP === 1) {
            this.wait_for_display_ready();
            this.write_register(UP1SR+2, this.read_register(UP1SR+2) & ~(1<<2));
        }
    }

    clear(color=0xFF, display_mode=DISPLAY_UPDATE_MODE_GC16) {
        // Set everything back to white in the fastest manner
        const buffer = Buffer.alloc(this.width * this.height * (this.config.BPP) / 8, color);
        this.draw(buffer, 0, 0, this.width, this.height, display_mode);
    }

    /** Device Status ****************************************************************************************************************************** */

    wait(duration = 1000) {
		this.gpio.msleep(duration);
	}

    reset() {
        this.gpio.write(this.config.PINS.RST, this.gpio.HIGH);
        this.wait(200);
        this.gpio.write(this.config.PINS.RST, this.gpio.LOW);
        this.wait(10);
        this.gpio.write(this.config.PINS.RST, this.gpio.HIGH);
        this.wait(200);
    }

    activate() {
        this.write_command(CMD_SYS_RUN);
    }

    standby() {
        this.write_command(CMD_STANDBY);
    }

    sleep() {
        this.write_command(CMD_SLEEP);
    }

    close() {
        console.log('Shutdown');
        this.sleep();
        this.gpio.spiEnd();
        this.gpio.exit();
    }
}

function mapBPP(bpp) {
    switch(bpp) {
        case 8: 
            return 3;
        case 4:
            return 2;
        case 2:
            return 0;
        case 1:
            return 3;
    }
}

function bytesTo16([v1, v2]) {
    return (v1 << 8) | v2;
}

// Little Endian
function bytesFrom32(v) {
    return [
        v >> 24 & 0xFF,
        v >> 16 & 0xFF,
        v >> 8 & 0xFF,
        v >> 0 & 0xFF
    ];
}

function bytesFrom16(v) {
    return [
        v >> 8 & 0xFF,
        v >> 0 & 0xFF
    ];
}

function fixString(str) {
    let output = str.split('');
    for (let i=0; i<str.length; i++) {
        let pos = (i % 2) ? i - 1 : i + 1;  // Generates sequence of 103254
        output[pos] = str.charAt(i);
    }
    return output.join('');
}

function roundTo32(v) {
    return v = v - (v % 32);
}

module.exports = IT8951;
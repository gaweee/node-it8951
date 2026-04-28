/**
 * IT8951 e-Paper Display Driver
 *
 * A port of the IT8951-ePaper C driver from Waveshare combined with concepts
 * from the Python PaperTTY IT8951 Driver.
 *
 * Key features:
 *   - Fast, uses native GPIO libraries (rpio)
 *   - Auto VCOM Detection
 *   - Supports 1, 2, 4 Bits Per Pixel (BPP)
 *   - Remappable Pins
 *   - Configurable Buffer Size
 *
 * @see https://github.com/gaweee/node-it8951
 * @see https://github.com/waveshare/IT8951-ePaper
 * @see https://github.com/joukos/PaperTTY
 */

const rpio = require('rpio');

// Rotation constants (not yet in use)
const ROTATE0 = 0;
// const ROTATE90 = 1;
// const ROTATE180 = 2;
// const ROTATE270 = 3;

// Endianness
const ENDIAN_LITTLE = 0;
// const ENDIAN_BIG = 1;

// Display update modes
const DISPLAY_UPDATE_MODE_INIT = 0;
const DISPLAY_UPDATE_MODE_GC16 = 2;
let DISPLAY_UPDATE_MODE_A2 = 6;

// Command codes
const CMD_SYS_RUN = 0x0001;
// const CMD_STANDBY = 0x0002;
const CMD_SLEEP = 0x0003;
const CMD_READ_REGISTER = 0x0010;
const CMD_WRITE_REGISTER = 0x0011;
const CMD_LOAD_IMAGE_AREA = 0x0021;
const CMD_LOAD_IMAGE_END = 0x0022;
const CMD_DISPLAY_AREA_BUFFER = 0x0037;
const CMD_GET_DEVICE_INFO = 0x0302;
const CMD_VCOM = 0x0039;

// Register addresses
const REG_SYSTEM_BASE = 0;
const REG_I80CPCR = REG_SYSTEM_BASE + 0x04;
const REG_DISPLAY_BASE = 0x1000;
const REG_LUTAFSR = REG_DISPLAY_BASE + 0x224;
const REG_MEMORY_CONV_BASE_ADDR = 0x0200;
const REG_MEMORY_CONV_LISAR = REG_MEMORY_CONV_BASE_ADDR + 0x0008;

// Display register addresses
const DISPLAY_REG_BASE = 0x1000;
const UP1SR = DISPLAY_REG_BASE + 0x138;
const BGVR = DISPLAY_REG_BASE + 0x250;

/** Default configuration */
const CONFIG = {
	MAX_BUFFER_SIZE: 4096,
	PINS: {
		RST: 11,  // 17 BCM
		CS: 24,   // 8 BCM
		BUSY: 18, // 24 BCM
	},
	VCOM: 2150,
	BPP: 4,
	ALIGN4BYTES: false,
	SWAP_BUFFER_ENDIANESS: true,
	ROTATION: ROTATE0,
	READY_TIMEOUT: 10000,          // Max ms to wait for BUSY pin
	DISPLAY_READY_TIMEOUT: 30000, // Max ms to wait for LUT engines to finish
	SPI_CLOCK_DIVIDER: 64,        // SPI clock divider (lower = faster, 32 may be too aggressive)
};

class IT8951 {
	constructor(options = {}) {
		this.config = { ...CONFIG, ...options };

		if (this.config.MODE_A2) {
			DISPLAY_UPDATE_MODE_A2 = this.config.MODE_A2;
		}
	}

	init() {
		this.initialized = true;

		this.gpio = rpio;
		this.gpio.init({ mapping: 'physical', gpiomem: false });

		this.gpio.spiBegin();
		this.gpio.spiSetClockDivider(this.config.SPI_CLOCK_DIVIDER);

		this.gpio.open(this.config.PINS.CS, this.gpio.OUTPUT);
		this.gpio.open(this.config.PINS.RST, this.gpio.OUTPUT, this.gpio.HIGH);
		this.gpio.open(this.config.PINS.BUSY, this.gpio.INPUT, this.gpio.PULL_DOWN);

		this.reset();
		this.activate();
		this.wait_for_ready();

		// Get Device Info
		this.write_command(CMD_GET_DEVICE_INFO);
		const device_info = this.read_data(40);

		// Parse device info: 4 x uint16 BE + 2 x 16-byte strings
		const width = device_info.readUInt16BE(0);
		const height = device_info.readUInt16BE(2);
		const img_addr_l = device_info.readUInt16BE(4);
		const img_addr_h = device_info.readUInt16BE(6);
		const firmware_version = device_info.subarray(8, 24).toString('ascii');
		const lut_version = device_info.subarray(24, 40).toString('ascii');

		this.width = width;
		this.height = height;
		this.img_addr = (img_addr_h << 16) | img_addr_l;

		console.log('width =', this.width);
		console.log('height =', this.height);
		console.log('img_addr =', this.img_addr.toString(16));
		console.log('firmware =', fixString(firmware_version));
		console.log('lut =', fixString(lut_version));

		// Set to Enable I80 Packed mode
		console.log('IT8951: Enabling I80 packed mode...');
		this.write_register(REG_I80CPCR, 0x0001);

		const currentVcom = this.get_vcom();
		if (this.config.VCOM !== currentVcom) {
			console.warn(`VCOM mismatch: device=${currentVcom}, config=${this.config.VCOM}. Updating...`);
			this.set_vcom(this.config.VCOM);
			console.log('VCOM =', `${(this.get_vcom() / 1000.0) * -1}v`);
		} else {
			console.log('VCOM =', `${(currentVcom / 1000.0) * -1}v (OK)`);
		}

		// Initialize the display with a blank image
		console.log('IT8951: Clearing display (INIT mode)...');
		this.wait_for_ready();
		this.clear(0xFF, DISPLAY_UPDATE_MODE_INIT);
		console.log('IT8951: Init complete.');
	}

	/** I/O Functions **************************************************************/

	spi_write(data) {
		const tx = Buffer.from(data);
		this.gpio.spiWrite(tx, tx.length);
		this.gpio.usleep(50); // settle time after SPI write
	}

	spi_read(n) {
		const tx = Buffer.alloc(n, 0x00);
		const rx = Buffer.alloc(n);
		this.gpio.spiTransfer(tx, rx, tx.length);
		return rx;
	}

	write_command(cmd, params = []) {
		const preamble = 0x6000;

		this.wait_for_ready();
		this.gpio.write(this.config.PINS.CS, this.gpio.LOW);
		this.gpio.usleep(10);
		this.spi_write(bytesFrom16(preamble));
		this.wait_for_ready();
		this.spi_write(bytesFrom16(cmd));
		this.gpio.write(this.config.PINS.CS, this.gpio.HIGH);
		this.gpio.usleep(10);

		if (params) {
			for (const param of params) this.write_data(bytesFrom16(param));
		}
	}

	write_data(data) {
		const preamble = 0x0000;

		this.wait_for_ready();
		this.gpio.write(this.config.PINS.CS, this.gpio.LOW);
		this.gpio.usleep(10);
		this.spi_write(bytesFrom16(preamble));
		this.wait_for_ready();

		for (let i = 0; i < data.length; i += this.config.MAX_BUFFER_SIZE) {
			const chunk = data.slice(i, i + this.config.MAX_BUFFER_SIZE);
			this.spi_write(chunk);
		}
		this.gpio.write(this.config.PINS.CS, this.gpio.HIGH);
		this.gpio.usleep(10);
	}

	read_data(n) {
		const preamble = 0x1000;

		this.wait_for_ready();
		this.gpio.write(this.config.PINS.CS, this.gpio.LOW);
		this.gpio.usleep(10);
		this.spi_write(bytesFrom16(preamble));
		this.wait_for_ready();

		this.spi_read(2); // Dummy read
		this.wait_for_ready();

		const result = this.spi_read(n);
		this.wait_for_ready();

		this.gpio.write(this.config.PINS.CS, this.gpio.HIGH);
		this.gpio.usleep(10);
		return result;
	}

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
		const timeout = this.config.READY_TIMEOUT;
		let elapsed = 0;
		while (this.gpio.read(this.config.PINS.BUSY) === 0) {
			if (elapsed >= timeout) {
				throw new Error(`IT8951: BUSY pin timeout after ${timeout}ms — display not responding`);
			}
			this.gpio.msleep(10);
			elapsed += 10;
		}
	}

	wait_for_display_ready() {
		const timeout = this.config.DISPLAY_READY_TIMEOUT;
		let elapsed = 0;
		while (this.read_register(REG_LUTAFSR) !== 0) {
			if (elapsed >= timeout) {
				throw new Error(`IT8951: LUT engine timeout after ${timeout}ms — display refresh stuck`);
			}
			this.wait(100);
			elapsed += 100;
		}
	}

	/** High Level Commands & Rendering ********************************************/

	get_vcom() {
		this.wait_for_ready();
		this.write_command(CMD_VCOM, [0]);
		return bytesTo16(this.read_data(2));
	}

	set_vcom(vcom) {
		this.write_command(CMD_VCOM, [1, vcom]);
	}

	display_area(x, y, w, h, display_mode) {
		const params = [
			x, y, w, h, display_mode,
			(this.img_addr & 0xFFFF),
			((this.img_addr >> 16) & 0xFFFF),
		];
		this.write_command(CMD_DISPLAY_AREA_BUFFER, params);
	}

	draw(buffer, x, y, w, h, display_mode = false) {
		this.wait_for_display_ready();
		if (!w) w = this.width;
		if (!h) h = this.height;

		// Workaround for 4-byte alignment on some Waveshare devices
		if (this.config.ALIGN4BYTES && this.config.BPP === 1) {
			x = roundTo32(x);
			w = roundTo32(w);
		}

		this.write_register(REG_MEMORY_CONV_LISAR + 2, (this.img_addr >> 16) & 0xFFFF);
		this.write_register(REG_MEMORY_CONV_LISAR, this.img_addr & 0xFFFF);

		// Define the region being loaded
		const params = [
			((ENDIAN_LITTLE << 8) | (mapBPP(this.config.BPP) << 4) | this.config.ROTATION),
			x, y, w, h,
		];
		this.write_command(CMD_LOAD_IMAGE_AREA, params);

		if (this.config.SWAP_BUFFER_ENDIANESS) {
			for (let i = 0; i < Math.trunc(buffer.length / 2) * 2; i += 2) {
				const tmp = buffer[i];
				buffer[i] = buffer[i + 1];
				buffer[i + 1] = tmp;
			}
		}

		this.write_data(buffer);
		this.write_command(CMD_LOAD_IMAGE_END);

		let update_mode = (this.config.BPP === 1) ? DISPLAY_UPDATE_MODE_A2 : DISPLAY_UPDATE_MODE_GC16;
		if (display_mode !== false) update_mode = display_mode;

		if (this.config.BPP === 1) {
			this.write_register(UP1SR + 2, this.read_register(UP1SR + 2) | (1 << 2));
			this.write_register(BGVR, (0x00 << 8) | 0xF0);
		}

		this.display_area(x, y, w, h, update_mode);

		if (this.config.BPP === 1) {
			this.wait_for_display_ready();
			this.write_register(UP1SR + 2, this.read_register(UP1SR + 2) & ~(1 << 2));
		}
	}

	clear(color = 0xFF, display_mode = DISPLAY_UPDATE_MODE_GC16) {
		const buffer = Buffer.alloc(this.width * this.height * this.config.BPP / 8, color);
		this.draw(buffer, 0, 0, this.width, this.height, display_mode);
	}

	/** Device Status **************************************************************/

	wait(duration = 1000) {
		this.gpio.msleep(duration);
	}

	reset() {
		if (!this.initialized) return;
		this.gpio.write(this.config.PINS.RST, this.gpio.HIGH);
		this.wait(200);
		this.gpio.write(this.config.PINS.RST, this.gpio.LOW);
		this.wait(10);
		this.gpio.write(this.config.PINS.RST, this.gpio.HIGH);
		this.wait(200);
	}

	activate() {
		if (!this.initialized) return;
		this.write_command(CMD_SYS_RUN);
	}

	standby() {
		if (!this.initialized) return;
		this.write_command(0x0002); // CMD_STANDBY
	}

	sleep() {
		if (!this.initialized) return;
		this.write_command(CMD_SLEEP);
	}

	close() {
		if (!this.initialized) return;
		this.initialized = false;

		console.log('Setting display to standby');
		this.sleep();
		this.wait(3000);
		this.gpio.spiEnd();
		this.gpio.exit();
	}
}

/** Helper functions ************************************************************/

function mapBPP(bpp) {
	switch (bpp) {
		case 8: return 3;
		case 4: return 2;
		case 2: return 0;
		case 1: return 3; // Hack: uses 8bpp mode for 1bpp
		default: return 2;
	}
}

function bytesTo16([v1, v2]) {
	return (v1 << 8) | v2;
}

function bytesFrom16(v) {
	return [
		(v >> 8) & 0xFF,
		(v >> 0) & 0xFF,
	];
}

function fixString(str) {
	const output = str.split('');
	for (let i = 0; i < str.length; i++) {
		const pos = (i % 2) ? i - 1 : i + 1;
		output[pos] = str.charAt(i);
	}
	return output.join('');
}

function roundTo32(v) {
	return v - (v % 32);
}

// Export the class and constants for testing/advanced use
module.exports = IT8951;
module.exports.DISPLAY_UPDATE_MODE_INIT = DISPLAY_UPDATE_MODE_INIT;
module.exports.DISPLAY_UPDATE_MODE_GC16 = DISPLAY_UPDATE_MODE_GC16;
module.exports.DISPLAY_UPDATE_MODE_A2 = DISPLAY_UPDATE_MODE_A2;

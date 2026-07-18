/**
 * IT8951 e-Paper Display Driver
 *
 * A port of the IT8951-ePaper C driver from Waveshare combined with concepts
 * from the Python PaperTTY IT8951 Driver.
 *
 * Key features:
 *   - Fast, uses an injectable SPI/GPIO transport
 *   - Auto VCOM Detection
 *   - Supports 1, 2, 4 Bits Per Pixel (BPP)
 *   - Remappable Pins
 *   - Configurable Buffer Size
 *
 * @see https://github.com/gaweee/node-it8951
 * @see https://github.com/waveshare/IT8951-ePaper
 * @see https://github.com/joukos/PaperTTY
 */

const LinuxSpiGpioTransport = require('./lib/transports/linux-spi-gpio');

function createLogger(enabled = true) {
	if (!enabled) {
		return {
			info() {},
			warn() {},
			error() {},
		};
	}
	return console;
}

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
	// VCOM is panel-specific. Null preserves the controller's stored value;
	// provide an explicit millivolt value only when intentionally overriding it.
	VCOM: null,
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
		this.transport = options.transport || new LinuxSpiGpioTransport(this.config);
		this.logger = options.logger || createLogger(this.config.LOG_ENABLED !== false);

		if (this.config.MODE_A2) {
			DISPLAY_UPDATE_MODE_A2 = this.config.MODE_A2;
		}
	}

	init({ clear = true, configure = true } = {}) {
		if (this.initialized) return this;
		this.initialized = true;

		this.gpio = this.transport;
		try {
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

			validateDimensions(width, height);
			this.width = width;
			this.height = height;
			this.img_addr = (img_addr_h << 16) | img_addr_l;
			this.deviceInfo = {
				width,
				height,
				image_address: this.img_addr,
				firmware: fixString(firmware_version).replace(/\0.*$/, '').trim(),
				lut: fixString(lut_version).replace(/\0.*$/, '').trim(),
			};

			this.logger.info('width =', this.width);
			this.logger.info('height =', this.height);
			this.logger.info('img_addr =', this.img_addr.toString(16));
			this.logger.info('firmware =', fixString(firmware_version));
			this.logger.info('lut =', fixString(lut_version));

			if (configure) {
				// Set to Enable I80 Packed mode
				this.logger.info('IT8951: Enabling I80 packed mode...');
				this.write_register(REG_I80CPCR, 0x0001);

				const currentVcom = this.get_vcom();
				if (this.config.VCOM == null) {
					this.logger.info('VCOM =', `${(currentVcom / 1000.0) * -1}v (device-stored, no override)`);
				} else if (this.config.VCOM !== currentVcom) {
					this.logger.warn(`VCOM override: device=${currentVcom}, config=${this.config.VCOM}. Updating...`);
					this.set_vcom(this.config.VCOM);
					this.logger.info('VCOM =', `${(this.get_vcom() / 1000.0) * -1}v`);
				} else {
					this.logger.info('VCOM =', `${(currentVcom / 1000.0) * -1}v (OK)`);
				}
			}

			if (clear) {
				this.logger.info('IT8951: Clearing display (INIT mode)...');
				this.wait_for_ready();
				this.clear(0xFF, DISPLAY_UPDATE_MODE_INIT);
			}
			this.logger.info('IT8951: Init complete.');
			return this;
		} catch (error) {
			this.initialized = false;
			try { this.gpio.spiEnd(); } catch (_) { /* retain original error */ }
			try { this.gpio.exit(); } catch (_) { /* retain original error */ }
			throw error;
		}
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
		try {
			this.gpio.usleep(10);
			this.spi_write(bytesFrom16(preamble));
			this.wait_for_ready();
			this.spi_write(bytesFrom16(cmd));
		} finally {
			this.gpio.write(this.config.PINS.CS, this.gpio.HIGH);
			this.gpio.usleep(10);
		}

		if (params) {
			for (const param of params) this.write_data(bytesFrom16(param));
		}
	}

	write_data(data) {
		const preamble = 0x0000;

		this.wait_for_ready();
		this.gpio.write(this.config.PINS.CS, this.gpio.LOW);
		try {
			this.gpio.usleep(10);
			this.spi_write(bytesFrom16(preamble));
			this.wait_for_ready();

			for (let i = 0; i < data.length; i += this.config.MAX_BUFFER_SIZE) {
				const chunk = data.slice(i, i + this.config.MAX_BUFFER_SIZE);
				this.spi_write(chunk);
			}
		} finally {
			this.gpio.write(this.config.PINS.CS, this.gpio.HIGH);
			this.gpio.usleep(10);
		}
	}

	read_data(n) {
		const preamble = 0x1000;

		this.wait_for_ready();
		this.gpio.write(this.config.PINS.CS, this.gpio.LOW);
		try {
			this.gpio.usleep(10);
			this.spi_write(bytesFrom16(preamble));
			this.wait_for_ready();

			this.spi_read(2); // Dummy read
			this.wait_for_ready();

			const result = this.spi_read(n);
			this.wait_for_ready();
			return result;
		} finally {
			this.gpio.write(this.config.PINS.CS, this.gpio.HIGH);
			this.gpio.usleep(10);
		}
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
		if (x == null) x = 0;
		if (y == null) y = 0;
		if (!w) w = this.width;
		if (!h) h = this.height;
		validateDrawBuffer(buffer, x, y, w, h, this.config.BPP, this.width, this.height);
		this.wait_for_display_ready();

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

		let txBuffer = buffer;
		if (this.config.SWAP_BUFFER_ENDIANESS) {
			txBuffer = Buffer.from(buffer);
			for (let i = 0; i < Math.trunc(txBuffer.length / 2) * 2; i += 2) {
				const tmp = txBuffer[i];
				txBuffer[i] = txBuffer[i + 1];
				txBuffer[i + 1] = tmp;
			}
		}

		this.write_data(txBuffer);
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

		this.logger.info('Setting display to standby');
		try {
			this.sleep();
			this.wait(3000);
		} finally {
			this.initialized = false;
			try {
				this.gpio.spiEnd();
			} finally {
				this.gpio.exit();
			}
		}
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

function validateDimensions(width, height) {
	if (!Number.isInteger(width) || !Number.isInteger(height)
		|| width <= 0 || height <= 0 || width === 0xFFFF || height === 0xFFFF) {
		throw new Error(`IT8951 returned invalid display dimensions ${width}x${height}`);
	}
}

function validateDrawBuffer(buffer, x, y, w, h, bpp, displayWidth, displayHeight) {
	if (!Buffer.isBuffer(buffer)) throw new TypeError('IT8951 draw buffer must be a Buffer');
	if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w <= 0 || h <= 0) {
		throw new RangeError(`Invalid IT8951 draw area x=${x}, y=${y}, width=${w}, height=${h}`);
	}
	if (displayWidth && displayHeight && (x + w > displayWidth || y + h > displayHeight)) {
		throw new RangeError(`IT8951 draw area ${x},${y} ${w}x${h} exceeds ${displayWidth}x${displayHeight}`);
	}
	const expectedLength = (w * h * bpp) / 8;
	if (!Number.isInteger(expectedLength) || buffer.length !== expectedLength) {
		throw new RangeError(`IT8951 expected ${expectedLength} bytes for ${w}x${h} at ${bpp}BPP, received ${buffer.length}`);
	}
}

// Export the class and constants for testing/advanced use
module.exports = IT8951;
module.exports.DISPLAY_UPDATE_MODE_INIT = DISPLAY_UPDATE_MODE_INIT;
module.exports.DISPLAY_UPDATE_MODE_GC16 = DISPLAY_UPDATE_MODE_GC16;
module.exports.DISPLAY_UPDATE_MODE_A2 = DISPLAY_UPDATE_MODE_A2;
module.exports.LinuxSpiGpioTransport = LinuxSpiGpioTransport;
module.exports.createLogger = createLogger;

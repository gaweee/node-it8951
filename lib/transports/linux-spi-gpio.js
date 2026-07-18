/**
 * Synchronous Linux SPI + GPIO character-device transport.
 *
 * This module deliberately contains no IT8951 knowledge. It can be replaced
 * with another transport in tests or by consumers targeting different boards.
 */
/* eslint-disable global-require, import/no-unresolved, class-methods-use-this */

const DEFAULTS = {
    bus: 1,
    device: 0,
    speed_hz: 2000000,
    gpio_chip: '/dev/gpiochip1',
    reset_line: 226,
    busy_line: 228,
    cs_line: 229,
};

function gpioChipNumber(chip) {
    if (Number.isInteger(chip)) return chip;
    const match = String(chip).match(/gpiochip(\d+)$/);
    if (!match) throw new Error(`Invalid GPIO chip ${chip}; expected a number or /dev/gpiochipN`);
    return Number(match[1]);
}

class LinuxSpiGpioTransport {
    constructor(options = {}) {
        this.config = { ...DEFAULTS, ...options };
        this.opened = false;

        // rpio-compatible constants used by the original node-it8951 driver.
        this.OUTPUT = 'output';
        this.INPUT = 'input';
        this.HIGH = 1;
        this.LOW = 0;
        this.PULL_DOWN = 'pull-down';
    }

    init() {}

    spiBegin() { this.open(); }

    spiSetClockDivider() {
        // Linux spidev uses the explicit speed_hz option instead.
    }

    // With no arguments this opens the transport. Calls with a pin number are
    // the original rpio line declarations; all lines are already requested as
    // one group so CS can remain asserted while HRDY is checked.
    open(pin) {
        if (pin !== undefined) return;
        if (this.opened) return;

        // Load native modules only when real hardware is opened. This keeps the
        // protocol driver importable on development machines and in unit tests.
        let gpio;
        let spi;
        try {
            gpio = require('opengpio');
            spi = require('spi-device');
        } catch (error) {
            throw new Error(`Linux SPI/GPIO modules are unavailable: ${error.message}`);
        }

        const chip = gpioChipNumber(this.config.gpio_chip);
        try {
            this.resetLine = gpio.Default.output({ chip, line: this.config.reset_line });
            this.csLine = gpio.Default.output({ chip, line: this.config.cs_line });
            this.busyLine = gpio.Default.input(
                { chip, line: this.config.busy_line },
                { bias: gpio.Bias.PullDown },
            );
            this.spi = spi.openSync(this.config.bus, this.config.device, {
                mode: 0,
                maxSpeedHz: this.config.speed_hz,
                bitsPerWord: 8,
            });
            this.resetLine.value = true;
            this.csLine.value = true;
            this.opened = true;
        } catch (error) {
            this.close();
            throw new Error(`Unable to open IT8951 SPI/GPIO transport: ${error.message}`);
        }
    }

    writeBuffer(data) {
        this.assertOpen();
        const sendBuffer = Buffer.from(data);
        this.spi.transferSync([{
            sendBuffer,
            byteLength: sendBuffer.length,
            speedHz: this.config.speed_hz,
        }]);
    }

    spiWrite(data, length = data.length) {
        this.writeBuffer(data.subarray(0, length));
    }

    readBuffer(length) {
        this.assertOpen();
        const receiveBuffer = Buffer.alloc(length);
        this.spi.transferSync([{
            sendBuffer: Buffer.alloc(length),
            receiveBuffer,
            byteLength: length,
            speedHz: this.config.speed_hz,
        }]);
        return receiveBuffer;
    }

    spiTransfer(txBuffer, rxBuffer, length = txBuffer.length) {
        const result = this.readBuffer(length);
        result.copy(rxBuffer, 0, 0, length);
    }

    setReset(high) {
        this.assertOpen();
        this.resetLine.value = Boolean(high);
    }

    setCs(high) {
        this.assertOpen();
        this.csLine.value = Boolean(high);
    }

    isReady() {
        this.assertOpen();
        return this.busyLine.value;
    }

    writePin(pin, value) {
        const pins = this.config.PINS || {};
        if (pin === pins.CS) return this.setCs(value === this.HIGH);
        if (pin === pins.RST) return this.setReset(value === this.HIGH);
        throw new Error(`GPIO pin ${pin} is not configured as an IT8951 output`);
    }

    readPin(pin) {
        const pins = this.config.PINS || {};
        if (pin === pins.BUSY) return this.isReady() ? this.HIGH : this.LOW;
        throw new Error(`GPIO pin ${pin} is not configured as the IT8951 BUSY input`);
    }

    write(pin, value) { return this.writePin(pin, value); }

    read(pin) { return this.readPin(pin); }

    sleep(milliseconds) {
        if (milliseconds <= 0) return;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
    }

    sleepMicros(microseconds) {
        if (microseconds >= 1000) {
            this.sleep(microseconds / 1000);
            return;
        }
        const deadline = process.hrtime.bigint() + BigInt(Math.ceil(microseconds * 1000));
        while (process.hrtime.bigint() < deadline) { /* intentional short hardware delay */ }
    }

    msleep(milliseconds) { this.sleep(milliseconds); }

    usleep(microseconds) { this.sleepMicros(microseconds); }

    spiEnd() { this.close(); }

    exit() { this.close(); }

    close() {
        if (this.spi) {
            try { this.spi.closeSync(); } catch { /* best-effort cleanup */ }
            this.spi = null;
        }
        for (const name of ['busyLine', 'csLine', 'resetLine']) {
            if (this[name]) {
                try { this[name].stop(); } catch { /* best-effort cleanup */ }
                this[name] = null;
            }
        }
        this.opened = false;
    }

    assertOpen() {
        if (!this.opened) throw new Error('SPI/GPIO transport is not open');
    }
}

module.exports = LinuxSpiGpioTransport;
module.exports.gpioChipNumber = gpioChipNumber;

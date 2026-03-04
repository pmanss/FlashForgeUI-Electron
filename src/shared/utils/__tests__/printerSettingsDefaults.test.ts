import {
  applyPerPrinterDefaults,
  hasMissingDefaults,
  PER_PRINTER_SETTINGS_DEFAULTS,
} from '../printerSettingsDefaults.js';

describe('printerSettingsDefaults', () => {
  it('applies defaults for missing per-printer settings without mutating the input', () => {
    const source = {
      Name: 'Printer',
      webUIEnabled: undefined,
    };

    const result = applyPerPrinterDefaults(source);

    expect(result).toEqual({
      ...source,
      ...PER_PRINTER_SETTINGS_DEFAULTS,
    });
    expect(source).toEqual({
      Name: 'Printer',
      webUIEnabled: undefined,
    });
  });

  it('preserves explicitly configured values', () => {
    const result = applyPerPrinterDefaults({
      Name: 'Printer',
      customCameraEnabled: true,
      customCameraUrl: 'http://192.168.1.10:8080/?action=stream',
      customLedsEnabled: true,
      forceLegacyMode: true,
      webUIEnabled: false,
      showCameraFps: true,
    });

    expect(result.customCameraEnabled).toBe(true);
    expect(result.customCameraUrl).toBe('http://192.168.1.10:8080/?action=stream');
    expect(result.customLedsEnabled).toBe(true);
    expect(result.forceLegacyMode).toBe(true);
    expect(result.webUIEnabled).toBe(false);
    expect(result.showCameraFps).toBe(true);
  });

  it('detects when stored printer details are missing defaults', () => {
    expect(
      hasMissingDefaults({
        Name: 'Printer',
        customCameraEnabled: false,
      })
    ).toBe(true);

    expect(
      hasMissingDefaults({
        Name: 'Printer',
        ...PER_PRINTER_SETTINGS_DEFAULTS,
      })
    ).toBe(false);
  });
});

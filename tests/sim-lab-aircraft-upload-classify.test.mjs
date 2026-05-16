import { describe, it, expect } from 'vitest';
import {
  classifyAircraftUpload,
  sniffAircraftKindFromBuffer,
  isSafeUploadsRelativeUrl,
} from '../lib/routes/sim-lab-api.mjs';

describe('isSafeUploadsRelativeUrl — מניעת נתיג בטעון ארביטארי ללקוח', () => {
  it('מתיר /uploads/ מקוצר מהשרת', () => {
    expect(isSafeUploadsRelativeUrl('/uploads/av-1.jpeg')).toBe(true);
    expect(isSafeUploadsRelativeUrl('  /uploads/x.webp  ')).toBe(true);
  });
  it('חוסם פריצות .. ונסיגה מתוך הנתיג', () => {
    expect(isSafeUploadsRelativeUrl('/uploads/../../../etc/passwd')).toBe(false);
    expect(isSafeUploadsRelativeUrl('https://evil.test/x')).toBe(false);
    expect(isSafeUploadsRelativeUrl('\\uploads\\x')).toBe(false);
  });
});

describe('aircraft upload classification (meta + magic)', () => {
  it('זיהוי תמונה מ־MIME', () => {
    expect(classifyAircraftUpload({ mimetype: 'image/png', originalname: 'x' })).toBe('photo');
  });

  it('זיהוי JPEG לפי סגנון אוקטט־סטרים בלי MIME', () => {
    const buf = Buffer.alloc(16);
    buf[0] = 0xff;
    buf[1] = 0xd8;
    buf[2] = 0xff;
    expect(sniffAircraftKindFromBuffer(buf)).toBe('photo');
  });

  it('PNG לפי חתימת קובץ גם כשהשרת קיבל octet-stream ללא סיומת', () => {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xff, 0xff, 0xff]);
    expect(classifyAircraftUpload({ mimetype: 'application/octet-stream', originalname: 'blob' })).toBe('other');
    expect(sniffAircraftKindFromBuffer(sig)).toBe('photo');
  });

  it('GLB לפי מגי׳ק glTF', () => {
    const g = Buffer.alloc(20);
    Buffer.from('glTF').copy(g, 0);
    expect(sniffAircraftKindFromBuffer(g)).toBe('glb');
  });
});

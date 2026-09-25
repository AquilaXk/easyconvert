import { describe, it, expect } from 'vitest';
import { GET as getFormats } from '../src/app/api/formats/route';
import { GET as getHealth } from '../src/app/api/health/route';

describe('API Route Logic Tests', () => {
  it('GET /api/formats returns valid response structure', async () => {
    const res = await getFormats();
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.count).toBeGreaterThan(15);
    expect(Array.isArray(data.categories)).toBe(true);
    expect(Array.isArray(data.formats)).toBe(true);
  });

  it('GET /api/health returns healthy service status', async () => {
    const res = await getHealth();
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe('healthy');
    expect(data.service).toBe('EasyConvert');
    expect(data.features.imageProcessing).toBe(true);
    expect(data.features.documentProcessing).toBe(true);
    expect(data.features.dataTransformation).toBe(true);
    expect(data.features.archiveBundling).toBe(true);
  });
});

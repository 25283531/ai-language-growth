import type { ProviderServiceKind } from '@alg/shared-contracts';
import entries from './provider-presets.json';

export interface ProviderPreset {
  id: string;
  name: string;
  protocol: 'openai_compatible' | 'bailian_http' | 'volcengine_http' | 'baidu_speech' | 'iflytek_signed' | 'minimax_http' | 'tencent_soe' | 'tencent_cloud' | 'azure_speech' | 'speechace_http' | 'chivox_http';
  defaultBaseUrls: Partial<Record<ProviderServiceKind, string>>;
  services: ProviderServiceKind[];
  credentialRequired: boolean;
  documentationUrl: string | null;
  documentationUrls?: Partial<Record<ProviderServiceKind, string>>;
  credentialFields?: Array<{ key: string; label: string; required: boolean }>;
}

const PRESETS = entries as ProviderPreset[];

/** Public provider catalog. Preset values are data; service execution remains protocol-driven. */
export function listProviderPresets(): ProviderPreset[] {
  return PRESETS.map((preset) => ({
    ...preset,
    defaultBaseUrls: { ...preset.defaultBaseUrls },
    services: [...preset.services],
    ...(preset.documentationUrls ? { documentationUrls: { ...preset.documentationUrls } } : {}),
  }));
}

export function getProviderPreset(id: string): ProviderPreset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

export function presetSupportsService(id: string, service: ProviderServiceKind): boolean {
  return getProviderPreset(id)?.services.includes(service) ?? false;
}

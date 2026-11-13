import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildIflytekIseUrl,
  parseIflytekIseXml,
  transcodeToPcm16k,
} from '../src/iflytek-ise.ts';

function wav16kMono(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

describe('讯飞 ISE 流式协议', () => {
  it('生成 wss 地址并带上 HMAC 鉴权参数', () => {
    const url = buildIflytekIseUrl({
      appId: 'app',
      apiKey: 'key',
      apiSecret: 'secret',
      baseUrl: 'https://api.xfyun.cn/v1/service/v1/ise',
    });
    assert.match(url, /^wss:\/\/ise-api\.xfyun\.cn\/v2\/open-ise\?/);
    const parsed = new URL(url);
    const authorization = Buffer.from(parsed.searchParams.get('authorization') ?? '', 'base64').toString('utf8');
    assert.match(authorization, /api_key="key"/);
    assert.match(authorization, /algorithm="hmac-sha256"/);
    assert.match(authorization, /headers="host date request-line"/);
    assert.equal(parsed.searchParams.get('host'), 'ise-api.xfyun.cn');
  });

  it('解析 read_word 返回的总分、单词、音节和音素', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <xml_result>
        <read_word lan="en" type="study">
          <rec_paper>
            <read_word total_score="86.500000" is_rejected="false">
              <word content="hello" total_score="86.500000" dp_message="0">
                <syll content="he" total_score="90" dp_message="0">
                  <phone content="h" phone_score="88" dp_message="0" />
                  <phone content="e" phone_score="91" dp_message="0" />
                </syll>
                <syll content="llo" total_score="83" dp_message="16">
                  <phone content="l" phone_score="80" dp_message="0" />
                  <phone content="o" phone_score="75" dp_message="16" />
                </syll>
              </word>
            </read_word>
          </rec_paper>
        </read_word>
      </xml_result>`;
    const result = parseIflytekIseXml(xml);
    assert.equal(result.score, 86.5);
    assert.equal(result.rejected, false);
    assert.equal(result.units.find((unit) => unit.kind === 'word')?.text, 'hello');
    assert.equal(result.units.find((unit) => unit.text === 'llo')?.detail, '漏读');
    assert.equal(result.units.filter((unit) => unit.kind === 'phoneme').length, 4);
  });

  it('已有 16k 单声道 PCM WAV 时直接取数据段，不依赖 ffmpeg', async () => {
    const pcm = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]);
    const output = await transcodeToPcm16k({
      bytes: wav16kMono(pcm),
      fileName: 'hello.wav',
      mime: 'audio/wav',
    });
    assert.deepEqual(Buffer.from(output), pcm);
  });
});

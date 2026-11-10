/**
 * 电子书转换链路回归（TXT 编码 / EPUB 容器 / MOBI PalmDOC）。
 *
 * 夹具全部程序化构造（zip 与 mobi 均为独立实现，不复用被测代码），
 * 保证"实现写错 → 用例转红"而不是"夹具与实现共享同一个 bug"。
 */
import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { EpubConverter } from '@extract/converters/epub.converter';
import { MobiConverter, palmDocDecompress, trimTrailingEntries } from '@extract/converters/mobi.converter';
import { decodeTextFile, htmlToText } from '@extract/converters/book.common';
import { ExtractProcessor } from '@extract/extract.processor';

// ======================================================================
// 夹具构造：迷你 ZIP（独立实现，只覆盖被测代码需要的 stored/deflate）
// ======================================================================

interface ZipSpec {
  name: string;
  data: Buffer;
  method: 0 | 8;
}

function u16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
}
function u32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
}

function makeZip(specs: ZipSpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const s of specs) {
    const stored = s.method === 8 ? deflateRawSync(s.data) : s.data;
    const nameBytes = Buffer.from(s.name, 'utf8');

    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(s.method),
      u16(0),
      u16(0),
      u32(0), // crc（读取方只信任中央目录，可置 0）
      u32(stored.length),
      u32(s.data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      stored,
    ]);
    locals.push(local);

    centrals.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(s.method),
        u16(0),
        u16(0),
        u32(0),
        u32(stored.length),
        u32(s.data.length),
        u16(nameBytes.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBytes,
      ]),
    );
    offset += local.length;
  }

  const centralStart = offset;
  const central = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(specs.length),
    u16(specs.length),
    u32(central.length),
    u32(centralStart),
    u16(0),
  ]);
  return Buffer.concat([...locals, central, eocd]);
}

// ======================================================================
// 夹具构造：MOBI（PalmDB 容器，独立实现）
// ======================================================================

function makeMobi(opts: {
  compression: number;
  encoding: number;
  records: Buffer[];
  encryption?: number;
  extraFlags?: number;
  /** 声明的解压后正文长度；缺省 0 → 转换器按实际解压长度取全量 */
  textLength?: number;
}): Buffer {
  const { compression, encoding, records } = opts;

  // record0：PalmDOC 头(16) + MOBI 头（含 headerLength / textEncoding / extraFlags）
  const mobiHeaderLen = opts.extraFlags !== undefined ? 0xe8 : 0xe4;
  const record0 = Buffer.alloc(16 + mobiHeaderLen);
  record0.writeUInt16BE(compression, 0);
  record0.writeUInt32BE(opts.textLength ?? 0, 4);
  record0.writeUInt16BE(records.length, 8);
  record0.writeUInt16BE(4096, 10);
  record0.writeUInt16BE(opts.encryption ?? 0, 12);
  record0.write('MOBI', 16, 'ascii');
  record0.writeUInt32BE(mobiHeaderLen, 20);
  record0.writeUInt32BE(2, 24); // mobiType: book
  record0.writeUInt32BE(encoding, 28);
  if (opts.extraFlags !== undefined) {
    record0.writeUInt16BE(opts.extraFlags, 0xf2);
  }

  const all = [record0, ...records];

  // PalmDB 头 78 字节 + 记录偏移表
  const header = Buffer.alloc(78 + all.length * 8 + 2);
  header.write('TianjiSpecBook'.padEnd(32, '\0'), 0, 'ascii');
  header.write('BOOK', 60, 'ascii');
  header.write('MOBI', 64, 'ascii');
  header.writeUInt16BE(all.length, 76);
  let off = 78 + all.length * 8 + 2; // 数据区起点（含最后的 pad 2 字节）
  const offsets: number[] = [];
  for (const r of all) {
    offsets.push(off);
    off += r.length;
  }
  offsets.forEach((o, i) => {
    header.writeUInt32BE(o, 78 + i * 8);
  });
  return Buffer.concat([header, ...all]);
}

// ======================================================================
// ZIP 读取（经 EPUB 转换器间接验证 + 直接行为断言）
// ======================================================================

describe('EPUB 转换器', () => {
  const containerXml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata><dc:title>档案学导论</dc:title></metadata>
  <manifest>
    <item id="ch2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="img" href="cover.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="ch2"/>   <!-- manifest 顺序故意与 spine 不同：正文必须按 spine 走 -->
    <itemref idref="ch1"/>
  </spine>
</package>`;

  const ch1 = `<html><head><style>p { color: red }</style></head>
<body><h1>第一章&nbsp;总论</h1><p>档案是组织与个人留存的凭证&amp;记录。</p></body></html>`;
  const ch2 = `<html><body><h1>第二章<!-- 注释应被剔除 -->整理</h1><p>第四章之前的内容。<br/>第二行。</p>
<script>alert('no')</script></body></html>`;

  function epubFixture(method: 0 | 8): Buffer {
    return makeZip([
      { name: 'mimetype', data: Buffer.from('application/epub+zip'), method: 0 },
      { name: 'META-INF/container.xml', data: Buffer.from(containerXml), method },
      { name: 'OEBPS/content.opf', data: Buffer.from(opf), method },
      { name: 'OEBPS/chapter1.xhtml', data: Buffer.from(ch1), method },
      { name: 'OEBPS/chapter2.xhtml', data: Buffer.from(ch2), method },
      { name: 'OEBPS/style.css', data: Buffer.from('p{}'), method: 0 },
      { name: 'OEBPS/cover.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), method: 0 },
    ]);
  }

  it('按 spine 顺序抽取正文（manifest 顺序 ≠ spine 顺序也不乱）', async () => {
    const out = await new EpubConverter().convert(epubFixture(0), 'book.epub');
    expect(out.supported).toBe(true);
    expect(out.meta?.title).toBe('档案学导论');
    expect(out.meta?.chapters).toBe(2);
    const text = out.text;
    const at = (needle: string): number => text.indexOf(needle);
    expect(at('第二章')).toBeGreaterThanOrEqual(0);
    expect(at('第一章')).toBeGreaterThan(at('第二章')); // spine 里 ch2 在前
  });

  it('deflate 压缩条目同样可读，HTML 剥离 style/script/注释/实体', async () => {
    const out = await new EpubConverter().convert(epubFixture(8), 'book.epub');
    const text = out.text;
    expect(text).toContain('凭证&记录'); // &amp; 实体解码
    expect(text).toContain('第一章 总论'); // &nbsp; 折为空格
    expect(text).not.toContain('color: red'); // <style> 剔除
    expect(text).not.toContain("alert('no')"); // <script> 剔除
    expect(text).not.toContain('注释应被剔除'); // 注释剔除
    expect(text).toContain('第二行。'); // <br> 折行
  });

  it('OPF 不可用时退化为全量 HTML（不丢正文，只丢顺序）', async () => {
    const zip = makeZip([
      { name: 'mimetype', data: Buffer.from('application/epub+zip'), method: 0 },
      { name: 'z.xhtml', data: Buffer.from('<p>乙</p>'), method: 0 },
      { name: 'a.xhtml', data: Buffer.from('<p>甲</p>'), method: 0 },
    ]);
    const out = await new EpubConverter().convert(zip, 'broken.epub');
    expect(out.meta?.chapters).toBe(2);
    expect(out.text).toContain('甲');
    expect(out.text).toContain('乙');
    expect(out.text.indexOf('甲')).toBeLessThan(out.text.indexOf('乙')); // 路径排序
  });

  it('非 ZIP 容器显式报错（不静默返回空正文）', async () => {
    await expect(new EpubConverter().convert(Buffer.from('not a zip'), 'fake.epub')).rejects.toThrow(
      /EPUB 容器解析失败/,
    );
  });
});

// ======================================================================
// MOBI
// ======================================================================

describe('MOBI 转换器', () => {
  it('无压缩 + UTF-8：抽取正文并剥离标签', async () => {
    const mobi = makeMobi({
      compression: 1,
      encoding: 65001,
      records: [
        Buffer.from('<html><body><h1>第1章 检索</h1><p>依据片段必须可溯源。</p>', 'utf8'),
        Buffer.from('<p>第二章内容。</p></body></html>', 'utf8'),
      ],
    });
    const out = await new MobiConverter().convert(mobi, 'book.mobi');
    expect(out.supported).toBe(true);
    expect(out.text).toContain('依据片段必须可溯源');
    expect(out.text).toContain('第二章内容');
    expect(out.text).not.toContain('<h1>');
    expect(out.meta?.compression).toBe(1);
  });

  it('PalmDOC 压缩记录可解压（手工构造 LZ77 回引，独立于实现）', () => {
    const literal = Buffer.from('档案AB', 'utf8'); // 8 字节（汉字各 3 字节）
    const rec: number[] = [];
    rec.push(0x08, ...literal); // 0x08 = 后随 8 个字面量字节
    const lz = (8 << 3) | (8 - 3); // distance=8，length=8 → 14 位值 69
    rec.push(0x80 | (lz >> 8), lz & 0xff);
    const out = palmDocDecompress(Buffer.from(rec));
    expect(out.length).toBe(16);
    expect(out.subarray(0, 8)).toEqual(literal);
    expect(out.subarray(8, 16)).toEqual(literal); // 回引复制
  });

  it('压缩 MOBI（compression=2）整文件可抽取', async () => {
    const literal = Buffer.from('档案AB', 'utf8');
    const rec: number[] = [0x08, ...literal];
    const lz = (8 << 3) | (8 - 3); // distance=8，length=8
    rec.push(0x80 | (lz >> 8), lz & 0xff);
    const compressed = Buffer.from(rec);

    const mobi = makeMobi({ compression: 2, encoding: 65001, records: [compressed] });
    const out = await new MobiConverter().convert(mobi, 'book.mobi');
    expect(out.text).toContain('档案AB档案AB');
    expect(out.meta?.compression).toBe(2);
  });

  it('HUFF/CDIC 压缩显式报错并指路（不静默空正文）', async () => {
    const mobi = makeMobi({ compression: 17480, encoding: 65001, records: [Buffer.from('x')] });
    await expect(new MobiConverter().convert(mobi, 'book.mobi')).rejects.toThrow(/HUFF\/CDIC/);
  });

  it('DRM 加密显式报错', async () => {
    const mobi = makeMobi({
      compression: 1,
      encoding: 65001,
      records: [Buffer.from('x')],
      encryption: 1,
    });
    await expect(new MobiConverter().convert(mobi, 'book.mobi')).rejects.toThrow(/DRM/);
  });

  it('非 MOBI 文件（签名不符）显式报错', async () => {
    await expect(new MobiConverter().convert(Buffer.alloc(100, 1), 'fake.mobi')).rejects.toThrow(
      /BOOKMOBI/,
    );
  });

  it('trailing entries 按 extraDataFlags 剥离（multibyte overlap 位含在内）', () => {
    // 变长宽度编码：从缓冲区末尾向前扫描，字节低 7 位按 7 位/字节升权拼值，
    // bit7=1 的字节是终止字节；值 N 表示「整个 entry 占 N 字节（含宽度字节）」。
    const body = Buffer.from('X'.repeat(300) + 'ABCDEF', 'ascii'); // 306 字节
    // 单字节宽度（值 7 = 0x87）：entry = 6 数据字节 + 1 宽度字节
    const t1 = Buffer.concat([body, Buffer.from([1, 2, 3, 4, 5, 6]), Buffer.from([0x87])]);
    expect(trimTrailingEntries(t1, 0b10)).toEqual(body);
    // 双字节宽度（值 202：低 7 位组 74=0x4a，高位组 1=0x81 ⇒ buffer 顺序 [0x81, 0x4a]）
    const t2 = Buffer.concat([body, Buffer.alloc(200, 0x7f), Buffer.from([0x81, 0x4a])]);
    expect(trimTrailingEntries(t2, 0b10)).toEqual(body);
    // multibyte overlap（bit0）：overlap 字节在 trailing entries **之前**，
    // 剥完 entries 后再从尾部剥 (v&0x3)+1 字节
    const t3 = Buffer.concat([body, Buffer.from([0x00]), Buffer.from([1, 2, 3, 4, 5, 6]), Buffer.from([0x87])]);
    expect(trimTrailingEntries(t3, 0b11)).toEqual(body);
    // 护栏：判读出的"尾部"超过半个记录（此处值 127 > 记录 101 字节）→ 整条保留
    const absurd = Buffer.concat([Buffer.from('ABCDEF'), Buffer.alloc(94, 0x7f), Buffer.from([0xff])]);
    expect(trimTrailingEntries(absurd, 0b10).length).toBe(101);
    // 无 flags：原样返回
    expect(trimTrailingEntries(body, 0)).toBe(body);
  });
});

// ======================================================================
// TXT 编码
// ======================================================================

describe('TXT 编码解码', () => {
  it('UTF-8 无 BOM', () => {
    const { text, charset } = decodeTextFile(Buffer.from('档案正文', 'utf8'));
    expect(text).toBe('档案正文');
    expect(charset).toBe('utf-8');
  });

  it('UTF-8 BOM 去头', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('正文', 'utf8')]);
    const { text, charset } = decodeTextFile(buf);
    expect(text).toBe('正文');
    expect(charset).toBe('utf-8-sig');
  });

  it('GBK 回退（中文双字节不是合法 UTF-8，必须落 GBK 而非乱码）', () => {
    // "中文" 的 GBK 编码：D6 D0 CE C4（手工字节，独立于被测实现）
    const { text, charset } = decodeTextFile(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
    expect(text).toBe('中文');
    expect(charset).toBe('gbk');
  });

  it('UTF-16LE BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('AB', 'utf16le')]);
    const { text } = decodeTextFile(buf);
    expect(text).toBe('AB');
  });

  it('htmlToText 实体与空白压缩（EPUB/MOBI 共用）', () => {
    expect(htmlToText('<p>A&nbsp;&amp;&lt;B&gt;</p>\n<p>第二段</p>')).toBe('A &<B>\n\n第二段');
    expect(htmlToText('<div>行1</div><div>行2</div>')).toBe('行1\n行2');
    expect(htmlToText('&#x4e2d;&#25991;')).toBe('中文');
  });
});

// ======================================================================
// 路由分发（ExtractProcessor.route 为 public，专供本组用例）
// ======================================================================

describe('抽取路由分发', () => {
  function makeProcessor(): ExtractProcessor {
    // route 只做内存转换，不触达 dataSource/fetcher/indexer，占位即可
    return new ExtractProcessor({} as never, {} as never, {} as never);
  }

  it('epub：mime 命中 → EPUB 转换器（产出 spine 章节数）', async () => {
    const zip = makeZip([
      { name: 'META-INF/container.xml', data: Buffer.from(containerXmlSrc), method: 0 },
      { name: 'content.opf', data: Buffer.from(opfSrc), method: 0 },
      { name: 'p.xhtml', data: Buffer.from('<p>正文</p>'), method: 0 },
    ]);
    const out = await makeProcessor().route(zip, 'a.epub', 'application/epub+zip');
    expect(out.supported).toBe(true);
    expect(out.meta?.chapters).toBe(1);
  });

  it('epub：mime 错报但扩展名正确 → 仍走 EPUB 转换器（扩展名兜底）', async () => {
    const zip = makeZip([
      { name: 'META-INF/container.xml', data: Buffer.from(containerXmlSrc), method: 0 },
      { name: 'content.opf', data: Buffer.from(opfSrc), method: 0 },
      { name: 'p.xhtml', data: Buffer.from('<p>正文</p>'), method: 0 },
    ]);
    const out = await makeProcessor().route(zip, 'a.epub', 'application/octet-stream');
    expect(out.supported).toBe(true);
    expect(out.meta?.chapters).toBe(1);
  });

  it('mobi：mime 命中 → MOBI 转换器', async () => {
    const mobi = makeMobi({
      compression: 1,
      encoding: 65001,
      records: [Buffer.from('<p>正文</p>')],
    });
    const out = await makeProcessor().route(mobi, 'a.mobi', 'application/x-mobipocket-ebook');
    expect(out.supported).toBe(true);
    expect(out.text).toContain('正文');
  });

  it('txt：GBK 不再乱码（原实现硬编码 utf8 的回归）', async () => {
    const out = await makeProcessor().route(
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
      'a.txt',
      'text/plain',
    );
    expect(out.supported).toBe(true);
    expect(out.text).toBe('中文');
    expect(out.meta?.charset).toBe('gbk');
  });

  it('未知类型：supported=false（跳过不计失败）', async () => {
    const out = await makeProcessor().route(Buffer.alloc(4), 'a.bin', 'application/x-unknown');
    expect(out.supported).toBe(false);
  });
});

// 路由用例共用的 EPUB 夹具源（container + opf）
const containerXmlSrc = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
const opfSrc = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest><item id="p" href="p.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="p"/></spine>
</package>`;

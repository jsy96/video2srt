// 纯函数单元测试（Node 直接运行）：node tests/core.test.js
'use strict';

var assert = require('assert');
var V2S = require('../offscreen/core.js');

var passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + name);
}

console.log('core.test.js');

ok('secToSrtTime 基本换算', function () {
  assert.strictEqual(V2S.secToSrtTime(0), '00:00:00,000');
  assert.strictEqual(V2S.secToSrtTime(1.5), '00:00:01,500');
  assert.strictEqual(V2S.secToSrtTime(3661.5), '01:01:01,500');
  assert.strictEqual(V2S.secToSrtTime(59.9994), '00:00:59,999'); // 总毫秒取整避免进位
  assert.strictEqual(V2S.secToSrtTime(-3), '00:00:00,000');
  assert.strictEqual(V2S.secToSrtTime(3600 * 5 + 2), '05:00:02,000');
});

ok('floatToInt16 饱和转换', function () {
  var out = V2S.floatToInt16(new Float32Array([0, 1, -1, 0.5, 2]));
  assert.deepStrictEqual(Array.from(out), [0, 32767, -32767, 16384, 32767]);
});

ok('sanitizeFilename 去非法字符', function () {
  assert.strictEqual(V2S.sanitizeFilename('a/b:c*d?e"f<g>h|i'), 'a_b_c_d_e_f_g_h_i');
  assert.strictEqual(V2S.sanitizeFilename('   '), 'video');
  assert.strictEqual(V2S.sanitizeFilename('标题. '), '标题');
  var long = new Array(100).join('字');
  assert.ok(V2S.sanitizeFilename(long).length <= 60);
});

ok('buildBaseName 含标题与时间戳', function () {
  var name = V2S.buildBaseName('测试:视频', new Date(2026, 10, 6, 14, 30, 5));
  assert.strictEqual(name, '测试_视频_20261106-143005');
});

ok('buildSrtTimed 生成带偏移的 SRT', function () {
  var srt = V2S.buildSrtTimed(
    [{ start: 1, end: 2.5, text: '你好' }, { start: 3, end: 4, text: '世界' }],
    10, 0
  );
  assert.strictEqual(
    srt,
    '1\n00:00:11,000 --> 00:00:12,500\n你好\n\n2\n00:00:13,000 --> 00:00:14,000\n世界\n'
  );
});

ok('buildSrtTimed 按 maxEnd 截断', function () {
  var srt = V2S.buildSrtTimed(
    [{ start: 1, end: 2, text: '内' }, { start: 5, end: 6, text: '外' }],
    10, 12  // 视频总长 12s：第二段(15-16s)整体越界应丢弃
  );
  assert.ok(srt.indexOf('内') >= 0);
  assert.ok(srt.indexOf('外') < 0);
  // 第一段 end 12s > maxEnd 12s? start=11 end=12 → 正常保留
  assert.ok(srt.indexOf('00:00:11,000 --> 00:00:12,000') >= 0);
});

ok('buildSrtEstimated 均分时间轴且单调', function () {
  var srt = V2S.buildSrtEstimated('第一句。第二句比较长一些啊。第三句。', 0, 9);
  var times = srt.split('\n').filter(function (l) { return l.indexOf('-->') >= 0; });
  assert.strictEqual(times.length, 3);
  var prev = 0;
  times.forEach(function (l) {
    var a = l.split(' --> ')[0];
    var sec = (+a.slice(0, 2)) * 3600 + (+a.slice(3, 5)) * 60 + (+a.slice(6, 8));
    assert.ok(sec >= prev, '时间轴应单调递增');
    prev = sec;
  });
});

ok('buildSrtEstimatedPieces 多段顺序编号且不越段界', function () {
  var srt = V2S.buildSrtEstimatedPieces([
    { text: '第一段第一句。第一段第二句。', start: 0, end: 25 },
    { text: '第二段第一句。第二段第二句。', start: 25, end: 50 }
  ]);
  var blocks = srt.trim().split('\n\n');
  assert.strictEqual(blocks.length, 4, '四句字幕');
  // 编号跨段连续
  blocks.forEach(function (b, i) {
    assert.ok(b.indexOf((i + 1) + '\n') === 0, '块 ' + i + ' 编号应为 ' + (i + 1));
  });
  // 每句时间都落在自己段的 [start,end] 窗口内
  function secOf(ts) {
    return (+ts.slice(0, 2)) * 3600 + (+ts.slice(3, 5)) * 60 + (+ts.slice(6, 8)) + (+ts.slice(9, 12)) / 1000;
  }
  blocks.forEach(function (b, i) {
    var line = b.split('\n')[1].split(' --> ');
    var a = secOf(line[0]), z = secOf(line[1]);
    var segStart = i < 2 ? 0 : 25, segEnd = i < 2 ? 25 : 50;
    assert.ok(a >= segStart - 0.001 && z <= segEnd + 0.001, '块 ' + i + ' 时间应限制在段内：' + a + '~' + z);
  });
  // 空段被跳过、空结果返回空串
  assert.strictEqual(V2S.buildSrtEstimatedPieces([]), '');
  assert.strictEqual(V2S.buildSrtEstimatedPieces([{ text: ' ', start: 0, end: 5 }]), '');
});

ok('splitSentences 长句按逗号二次切分', function () {
  var sents = V2S.splitSentences('这是一个非常非常非常非常非常非常非常非常长的句子需要被切开，后半段还有内容。短句。', 20);
  assert.ok(sents.length >= 2);
  sents.forEach(function (s) { assert.ok(s.length <= 22, '单条不超过 maxLen+2：' + s); });
  assert.strictEqual(V2S.splitSentences('   ')[0], undefined);
});

ok('findCutPoints 选在静音处', function () {
  // 30s 伪音频：全程噪声，9.5~10.5s 静音；每 10s 一个切分目标
  var sr = 1000;
  var pcm = new Int16Array(30 * sr);
  for (var i = 0; i < pcm.length; i++) {
    pcm[i] = ((i * 37) % 1000) - 500;
  }
  for (var j = 9500; j < 10500; j++) pcm[j] = 0;
  var cuts = V2S.findCutPoints(pcm, sr, 10, 2);
  assert.ok(cuts.length >= 1, '应至少有一个切分点');
  assert.ok(cuts[0] >= 9500 && cuts[0] < 10500, '第一个切分点应落在静音区，实际 ' + cuts[0]);
  cuts.forEach(function (c) { assert.ok(c > 0 && c < pcm.length); });
});

console.log('\n全部通过：' + passed + ' 组断言');

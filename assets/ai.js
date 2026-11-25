"use strict";
/* 君意 · AI 老师 —— 纯前端，无后端
   设置 -> localStorage；对话 -> IndexedDB */

var LS_KEY = "jy_ai_settings_v1";
var DB_NAME = "jy_ai_db_v1";
var DB_STORE = "chats";

var DEFAULT_PROMPT = [
"你是一位耐心、幽默的中小学全科老师，正在一对一辅导一名 9-15 岁的学生。",
"你的目标不是把答案交出去，而是让学生真的会做这一类题。",
"",
"【说话方式】",
"1. 用中文口语，像坐在学生旁边说话。不用“综上所述”“鉴于”这类书面腔。",
"2. 多用短句，一句话尽量不超过 25 个字。用“第一步”“接着”“所以”推进。",
"3. 出现专业名词，先用一句大白话解释，再写正式名称。例如：“这个数叫因数，就是能把它整除的数”。",
"4. 默认按小学高年级到初一水平讲；学生说听懂了，再往深里加。",
"5. 学生答对了要具体地夸（夸过程，不夸“你真聪明”）；答错了先说“这一步思路是对的，只是……”。",
"",
"【讲题的固定流程，必须按顺序】",
"第一步 看懂题：先用一句话复述题目在问什么，再把已知条件一条条列出来（带单位）。",
"第二步 找思路：说明这题属于哪一类，为什么用这个方法，给一个生活中的比喻。",
"第三步 分步算：一步一步写，每一步只做一件事，并说明“为什么可以这么做”。",
"第四步 验算（关键，绝对不能跳过）：",
"   - 把算出的答案代回原题重算一遍，或者换一种方法再算一遍；",
"   - 检查单位、取值范围、是否符合常识（人数不能是小数、速度不能为负、时间不能倒流、面积不会是负数）；",
"   - 两次结果不一致，必须重新做，绝不允许把没把握的答案交给学生。",
"第五步 给结论：一句话说清最终答案，并写出完整答句。",
"第六步 举一反三：出 1 道同方法的变式小题（不给答案），让学生自己试。",
"",
"【绝对禁止】",
"- 禁止不验算就直接给答案。没把握时明确说“这条我再算一遍”，然后真的重算。",
"- 禁止一上来甩一大段过程加最终答案就结束，必须分步。",
"- 禁止编造公式、定理、历史年份、课文出处。记不清就说记不清。",
"- 不替学生写整篇作文，可以给提纲、开头示范和修改建议。",
"- 不聊与学习无关的内容，学生跑题就温和地拉回题目。",
"",
"【关于图片】",
"学生发来图片时，先把你在图上看到的题目内容完整念一遍（含所有数字和条件），再开始讲。",
"如果图片看不清或条件缺失，先问清楚，不要靠猜。",
"",
"【输出格式】",
"- 用短段落和小标题分步，不要一大坨文字。",
"- 数学式子用 LaTeX：行内 $...$，独立成行 $$...$$。",
"- 最终答案前加“【答案】”三个字。",
"- 结尾用一句话总结这道题的方法口诀，例如“见到平均分，先除再验乘”。"
].join("\n");

var DEF_SET = {
  base: "", key: "", model: "", proto: "chat",
  ctxK: 500, maxK: 64, think: "off", temp: 0.6,
  proxy: "", prompt: DEFAULT_PROMPT, tutor: "AI 老师"
};

var SET = {};
var chats = [];
var curId = null;
var streaming = false;
var abortCtl = null;
var atts = [];
var db = null;

/* ---------------- 小工具 ---------------- */
function $(id){ return document.getElementById(id); }
function esc(s){
  return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
var toastTimer = null;
function toast(msg, ms){
  var t = $("toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ t.classList.remove("on"); }, ms || 2200);
}
function uid(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function pad2(n){ return n < 10 ? "0" + n : "" + n; }
function nowStr(){
  var d = new Date();
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

/* ---------------- IndexedDB ---------------- */
function openDB(){
  return new Promise(function(res, rej){
    var rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = function(){
      var d = rq.result;
      if(!d.objectStoreNames.contains(DB_STORE)){
        d.createObjectStore(DB_STORE, { keyPath: "id" });
      }
    };
    rq.onsuccess = function(){ res(rq.result); };
    rq.onerror = function(){ rej(rq.error); };
  });
}
function dbAll(){
  return new Promise(function(res, rej){
    var tx = db.transaction(DB_STORE, "readonly");
    var rq = tx.objectStore(DB_STORE).getAll();
    rq.onsuccess = function(){ res(rq.result || []); };
    rq.onerror = function(){ rej(rq.error); };
  });
}
function dbPut(obj){
  return new Promise(function(res, rej){
    var tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(obj);
    tx.oncomplete = function(){ res(true); };
    tx.onerror = function(){ rej(tx.error); };
  });
}
function dbDel(id){
  return new Promise(function(res, rej){
    var tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete = function(){ res(true); };
    tx.onerror = function(){ rej(tx.error); };
  });
}

function dbPutSafe(obj){
  if(!db) return Promise.resolve(false);
  return dbPut(obj).catch(function(e){ console.warn("保存对话失败", e); return false; });
}
function dbClear(){
  return new Promise(function(res, rej){
    var tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).clear();
    tx.oncomplete = function(){ res(true); };
    tx.onerror = function(){ rej(tx.error); };
  });
}

/* ---------------- 设置 ---------------- */
function loadSet(){
  var s = {};
  var i;
  for(i in DEF_SET){ if(Object.prototype.hasOwnProperty.call(DEF_SET, i)) s[i] = DEF_SET[i]; }
  try{
    var raw = localStorage.getItem(LS_KEY);
    if(raw){
      var o = JSON.parse(raw) || {};
      for(i in o){ if(Object.prototype.hasOwnProperty.call(o, i) && o[i] !== undefined && o[i] !== null) s[i] = o[i]; }
    }
  }catch(e){}
  // 老版本默认是 128K / 8K，升级到 500K / 64K（用户自己改过其它数值的不动）
  if(s.ctxK === 128 && s.maxK === 8){ s.ctxK = 500; s.maxK = 64; }
  if(s.think === "mid") s.think = "medium";   // 旧版本五档 -> 七档
  return s;
}
function saveSet(){
  try{ localStorage.setItem(LS_KEY, JSON.stringify(SET)); }
  catch(e){ toast("设置保存失败：浏览器存储已满或被禁用"); }
}
function configured(){ return !!(SET.base && SET.key && SET.model); }

/* ---------------- Markdown（轻量，够用） ---------------- */
var BT = String.fromCharCode(96);
var RE_INLINE_CODE = new RegExp(BT + "([^" + BT + "]+)" + BT, "g");
var RE_FENCE = new RegExp("^\\s*" + BT + BT + BT);

function inlineMd(s){
  s = s.replace(RE_INLINE_CODE, function(m, c){ return "<code>" + c + "</code>"; });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}
/* 把公式抽出来换成占位符，避免 LaTeX 里的 _ { } * 被 markdown 当成强调符号打散 */
/* 公式保护：
   markdown 会把 LaTeX 里的 _ { } * # 当成语法打散，
   所以先把公式换成占位符，整段处理完再换成 data 属性，
   最后由 KaTeX 直接读属性渲染，绝不让 markdown / esc 碰到公式原文。 */
var __mathBag = [];
var PH_A = "\u2063JYM";
var PH_B = "\u2063";
function protectMath(src){
  __mathBag = [];
  var out = String(src);
  function bag(prefix, inner){
    __mathBag.push(prefix + inner + prefix);
    return PH_A + (__mathBag.length - 1) + PH_B;
  }
  // 1) $$...$$ 块级
  out = out.replace(/\$\$([\s\S]+?)\$\$/g, function(m, inner){ return bag("$$", inner); });
  // 2) \[...\] 块级
  out = out.replace(/\\\[([\s\S]+?)\\\]/g, function(m, inner){ return bag("$$", inner); });
  // 3) \(...\) 行内
  out = out.replace(/\\\(([\s\S]+?)\\\)/g, function(m, inner){ return bag("$", inner); });
  // 4) $...$ 行内（不跨行）
  out = out.replace(/(^|[^\\$])\$([^\$\n]+?)\$(?!\$)/g, function(m, pre, inner){
    return pre + bag("$", inner);
  });
  return out;
}
function restoreMath(html){
  if(!__mathBag.length) return html;
  var re = new RegExp(PH_A + "(\\d+)" + PH_B, "g");
  return html.replace(re, function(m, i){
    var tex = __mathBag[+i];
    if(tex == null) return "";
    var attr = String(tex).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    return '<span class="math-tex" data-tex="' + attr + '"></span>';
  });
}

function md(src){
  if(!src) return "";
  var safeSrc = protectMath(src);
  var lines = String(safeSrc).replace(/\r\n/g, "\n").split("\n");
  var out = [];
  var i = 0, m;
  var inCode = false, codeBuf = [], codeLang = "";
  var listType = null, listBuf = [];
  var pbuf = [];

  function flushList(){
    if(listType){
      out.push("<" + listType + ">" + listBuf.join("") + "</" + listType + ">");
      listType = null; listBuf = [];
    }
  }
  function flushP(){
    if(pbuf.length){
      var inner = inlineMd(esc(pbuf.join("\n"))).replace(/\n/g, "<br>");
      var cls = inner.indexOf("【答案】") >= 0 ? ' class="ans"' : "";
      out.push("<p" + cls + ">" + inner + "</p>");
      pbuf = [];
    }
  }

  while(i < lines.length){
    var line = lines[i];

    if(RE_FENCE.test(line)){
      flushP(); flushList();
      if(!inCode){
        inCode = true; codeBuf = [];
        codeLang = line.replace(new RegExp("^\\s*" + BT + BT + BT + "\\s*"), "").trim();
      }else{
        inCode = false;
        out.push('<pre><code>' + esc(codeBuf.join("\n")) + "</code></pre>");
      }
      i++; continue;
    }
    if(inCode){ codeBuf.push(line); i++; continue; }

    if(/^\s*$/.test(line)){ flushP(); flushList(); i++; continue; }

    m = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if(m){ flushP(); flushList(); var lv = m[1].length;
      out.push("<h" + lv + ">" + inlineMd(esc(m[2])) + "</h" + lv + ">"); i++; continue; }

    if(/^\s{0,3}([-*_])\s*\1\s*\1.*$/.test(line)){ flushP(); flushList(); out.push("<hr>"); i++; continue; }

    if(/^\s*>/.test(line)){
      flushP(); flushList();
      var qbuf = [];
      while(i < lines.length && /^\s*>/.test(lines[i])){
        qbuf.push(lines[i].replace(/^\s*>\s?/, "")); i++;
      }
      out.push("<blockquote>" + inlineMd(esc(qbuf.join("\n"))).replace(/\n/g, "<br>") + "</blockquote>");
      continue;
    }

    m = line.match(/^\s*([-*+])\s+(.*)$/);
    if(m){
      flushP();
      if(listType !== "ul"){ flushList(); listType = "ul"; }
      listBuf.push("<li>" + inlineMd(esc(m[2])) + "</li>"); i++; continue;
    }
    m = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if(m){
      flushP();
      if(listType !== "ol"){ flushList(); listType = "ol"; }
      listBuf.push("<li>" + inlineMd(esc(m[2])) + "</li>"); i++; continue;
    }

    flushList();
    pbuf.push(line);
    i++;
  }
  flushP(); flushList();
  if(inCode){ out.push('<pre><code>' + esc(codeBuf.join("\n")) + "</code></pre>"); }
  return restoreMath(out.join("\n"));
}
/* KaTeX 渲染：直接读 .math-tex 的 data-tex，不依赖正则切分，最稳 */
function renderMath(el){
  if(!window.katex) return;
  var nodes = el.querySelectorAll(".math-tex");
  for(var i = 0; i < nodes.length; i++){
    var n = nodes[i];
    if(n.getAttribute("data-done")) continue;
    var tex = n.getAttribute("data-tex") || "";
    if(!tex) continue;
    var display = tex.charAt(0) === "$" && tex.charAt(1) === "$";
    var body = display ? tex.slice(2, tex.length - 2) : tex.slice(1, tex.length - 1);
    try{
      katex.render(body, n, { displayMode: display, throwOnError: false, strict: false });
      n.setAttribute("data-done", "1");
    }catch(e){
      n.setAttribute("data-done", "1");
      n.textContent = tex;
    }
  }
}

/* ---------------- 侧栏 ---------------- */
function sortChats(){
  chats.sort(function(a, b){ return (b.updatedAt || 0) - (a.updatedAt || 0); });
}
function dayLabel(ts){
  if(!ts) return "更早";
  var d = new Date(ts), n = new Date();
  if(d.toDateString() === n.toDateString()) return "今天";
  var y = new Date(n.getTime() - 86400000);
  if(d.toDateString() === y.toDateString()) return "昨天";
  if(n - d < 7 * 86400000) return "最近 7 天";
  if(n - d < 30 * 86400000) return "最近 30 天";
  return d.getFullYear() + " 年 " + (d.getMonth() + 1) + " 月";
}
function renderList(){
  var q = ($("q").value || "").trim().toLowerCase();
  var box = $("chatlist");
  var arr = chats.filter(function(c){
    if(!q) return true;
    if((c.title || "").toLowerCase().indexOf(q) >= 0) return true;
    var ms = c.messages || [];
    for(var i = 0; i < ms.length; i++){
      if((ms[i].text || "").toLowerCase().indexOf(q) >= 0) return true;
    }
    return false;
  });
  if(!arr.length){
    box.innerHTML = '<div class="side-empty">' + (q ? "没有找到相关对话" : "还没有对话<br>点上面的“新对话”开始") + "</div>";
    return;
  }
  var html = "";
  var lastDay = "";
  for(var j = 0; j < arr.length; j++){
    var c = arr[j];
    var day = dayLabel(c.updatedAt);
    if(day !== lastDay){ html += '<div class="grp">' + day + "</div>"; lastDay = day; }
    html += '<div class="citem' + (c.id === curId ? " on" : "") + '" data-id="' + c.id + '">' +
      '<span class="ttl">' + esc(c.title || "新对话") + "</span>" +
      '<button class="x" data-del="' + c.id + '" title="删除">×</button></div>';
  }
  box.innerHTML = html;
}

/* ---------------- 消息渲染 ---------------- */
function scrollBottom(force){
  var sc = $("scroll");
  if(!sc) return;
  if(force || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 180){
    sc.scrollTop = sc.scrollHeight;
  }
}
function addMsgNode(role, text, imgs, think){
  var wrap = document.createElement("div");
  wrap.className = "msg " + (role === "user" ? "me" : "ai");
  var h = '<div class="ava">' + (role === "user" ? "我" : "师") + "</div>" +
          '<div class="body"><div class="who">' +
          esc(role === "user" ? "我" : (SET.tutor || "AI 老师")) + "</div>";
  if(role !== "user" && think){
    h += '<details class="think"><summary><span class="arw">▶</span>思考过程</summary>' +
         '<div class="in">' + esc(think) + "</div></details>";
  }
  h += '<div class="bubble"></div>';
  if(role !== "user"){
    h += '<div class="acts"><button data-act="copy">复制</button><button data-act="regen">重答</button></div>';
  }
  h += "</div>";
  wrap.innerHTML = h;
  var bub = wrap.querySelector(".bubble");
  if(imgs && imgs.length){
    for(var i = 0; i < imgs.length; i++){
      var im = document.createElement("img");
      im.className = "att";
      im.src = imgs[i];
      bub.appendChild(im);
    }
  }
  if(text){
    var d = document.createElement("div");
    d.className = "md";
    d.innerHTML = md(text);
    renderMath(d);
    bub.appendChild(d);
  }
  return wrap;
}
function renderChat(c, animate){
  var box = $("msgs");
  box.innerHTML = "";
  $("chatTitle").textContent = c.title || "新对话";
  var ms = c.messages || [];
  var has = false;
  for(var i = 0; i < ms.length; i++){
    var m = ms[i];
    if(m.role === "system") continue;
    var node = (m.role === "user") ? addMsgNode("user", m.text, m.imgs)
                                   : addMsgNode("assistant", m.text, null, m.think);
    if(!animate) node.style.animation = "none";
    box.appendChild(node);
    has = true;
  }
  $("welcome").style.display = has ? "none" : "flex";
  $("scroll").style.display = has ? "block" : "none";
  if(has) scrollBottom(true);
}

/* ---------------- 会话操作 ---------------- */
function newChat(){
  if(streaming) stopStream();
  curId = null;
  atts = [];
  renderAtts();
  $("ta").value = "";
  autoGrow();
  $("chatTitle").textContent = "新对话";
  $("msgs").innerHTML = "";
  $("welcome").style.display = "flex";
  $("scroll").style.display = "none";
  renderList();
  closeSide();
  try{ $("ta").focus(); }catch(e){}
}
function openChat(id){
  if(streaming) stopStream();
  var c = null;
  for(var i = 0; i < chats.length; i++){ if(chats[i].id === id){ c = chats[i]; break; } }
  if(!c) return;
  curId = id;
  atts = [];
  renderAtts();
  renderChat(c, false);
  renderList();
  closeSide();
}
function curChat(){
  for(var i = 0; i < chats.length; i++){ if(chats[i].id === curId) return chats[i]; }
  return null;
}

/* ---------------- 请求构造 ---------------- */
function normBase(u){
  u = String(u || "").trim().replace(/\/+$/, "");
  u = u.replace(/\/chat\/completions$/i, "").replace(/\/responses$/i, "").replace(/\/messages$/i, "");
  return u;
}
function endpoint(proto){
  var b = normBase(SET.base);
  if(proto === "responses") return b + "/responses";
  if(proto === "anthropic") return b + "/messages";
  return b + "/chat/completions";
}
function withProxy(url){
  var p = String(SET.proxy || "").trim().replace(/\/+$/, "");
  if(!p) return url;
  return p + "/proxy?u=" + encodeURIComponent(url);
}
/* 七档推理强度：off / minimal / low / medium / high / xhigh / max
   OpenAI 系直接用同名（xhigh 由各家自行解释，不认识会走 400 降级），
   Anthropic 用 budget_tokens 换算 */
var THINK_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function effortOf(){
  if(SET.think === "off" || !SET.think) return null;
  return SET.think;   // off/minimal/low/medium/high/xhigh/max 原样传给接口
}
function anthropicBudget(){
  if(SET.think === "minimal") return 1024;
  if(SET.think === "low") return 2048;
  if(SET.think === "medium") return 4096;
  if(SET.think === "high") return 8192;
  if(SET.think === "xhigh") return 16384;
  if(SET.think === "max") return 32768;
  return 0;
}
function estTokens(m){
  var t = 0;
  if(m.imgs && m.imgs.length) t += 850 * m.imgs.length;
  var s = String(m.text || "");
  var cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  t += cjk + Math.ceil((s.length - cjk) / 3.5);
  return t + 6;
}
/* 历史裁剪：
   1. 从最新往回装，装不下就停（保证不超上下文）
   2. 图片只保留最近 3 张，更早的图片换成文字占位
      —— 这是最大的加速点：图片 base64 很占体积，
         每轮都把整本相册重传一次，接口再快也会慢 */
var KEEP_IMG = 3;
function buildHistory(c){
  var ms = (c.messages || []).filter(function(m){ return m.role === "user" || m.role === "assistant"; });
  var budget = Math.max(2000, (Number(SET.ctxK) || 500) * 1024 * 0.62);
  var keep = [];
  var total = 0;
  var imgLeft = KEEP_IMG;
  for(var i = ms.length - 1; i >= 0; i--){
    var src = ms[i];
    var m = { role: src.role, text: src.text || "", imgs: src.imgs || [] };
    // 只留最近几张图，其余降级成文字，减少请求体积
    if(m.imgs && m.imgs.length){
      if(imgLeft > 0){
        var use = Math.min(imgLeft, m.imgs.length);
        m.imgs = m.imgs.slice(m.imgs.length - use);
        imgLeft -= use;
      }else{
        m.imgs = [];
        m.text = (m.text ? m.text + "\n" : "") + "（此处原本有 " + src.imgs.length + " 张图片，为节省时间已省略）";
      }
    }
    var t = estTokens(m);
    if(total + t > budget && keep.length >= 2) break;
    total += t;
    keep.unshift(m);
  }
  while(keep.length && keep[0].role === "assistant") keep.shift();
  return keep;
}
function imgParts(imgs, proto){
  var arr = [];
  for(var i = 0; i < (imgs || []).length; i++){
    var d = imgs[i];
    var mm = d.match(/^data:([^;]+);base64,(.*)$/);
    if(!mm) continue;
    if(proto === "anthropic") arr.push({ type: "image", source: { type: "base64", media_type: mm[1], data: mm[2] } });
    else if(proto === "responses") arr.push({ type: "input_image", image_url: d });
    else arr.push({ type: "image_url", image_url: { url: d } });
  }
  return arr;
}
function buildBody(c, msgs){
  var proto = SET.proto;
  var maxOut = Math.max(256, Math.round((Number(SET.maxK) || 8) * 1024));
  var temp = (SET.temp === null || SET.temp === "" || isNaN(Number(SET.temp))) ? null : Number(SET.temp);
  var eff = effortOf();
  var pm = String(SET.prompt || "").trim();
  var i, m;

  if(proto === "chat"){
    var out = [];
    if(pm) out.push({ role: "system", content: pm });
    for(i = 0; i < msgs.length; i++){
      m = msgs[i];
      if(m.role === "user" && m.imgs && m.imgs.length){
        var parts = [{ type: "text", text: m.text || "请看我发的图片。" }].concat(imgParts(m.imgs, proto));
        out.push({ role: "user", content: parts });
      }else{
        out.push({ role: m.role, content: m.text || "" });
      }
    }
    var body = { model: SET.model, messages: out, stream: true, max_tokens: maxOut };
    if(temp !== null) body.temperature = temp;
    if(eff) body.reasoning_effort = eff;
    return body;
  }

  if(proto === "responses"){
    var input = [];
    for(i = 0; i < msgs.length; i++){
      m = msgs[i];
      var cc;
      if(m.role === "user" && m.imgs && m.imgs.length){
        cc = [{ type: "input_text", text: m.text || "请看我发的图片。" }].concat(imgParts(m.imgs, proto));
      }else if(m.role === "user"){
        cc = [{ type: "input_text", text: m.text || "" }];
      }else{
        cc = [{ type: "output_text", text: m.text || "" }];
      }
      input.push({ role: m.role, content: cc });
    }
    var b2 = { model: SET.model, input: input, stream: true, max_output_tokens: maxOut };
    if(pm) b2.instructions = pm;
    if(temp !== null) b2.temperature = temp;
    if(eff) b2.reasoning = { effort: eff, summary: "auto" };
    return b2;
  }

  /* anthropic */
  var arr = [];
  for(i = 0; i < msgs.length; i++){
    m = msgs[i];
    if(m.role === "assistant"){
      arr.push({ role: "assistant", content: [{ type: "text", text: m.text || "" }] });
      continue;
    }
    var p2 = [];
    if(m.text) p2.push({ type: "text", text: m.text });
    if(m.imgs && m.imgs.length) p2 = p2.concat(imgParts(m.imgs, proto));
    if(!p2.length) p2.push({ type: "text", text: "…" });
    arr.push({ role: "user", content: p2 });
  }
  var budget = anthropicBudget();
  var b3 = { model: SET.model, messages: arr, stream: true, max_tokens: Math.max(maxOut, budget + 1024) };
  if(pm) b3.system = pm;
  if(budget > 0) b3.thinking = { type: "enabled", budget_tokens: budget };
  else if(temp !== null) b3.temperature = temp;
  return b3;
}
function buildHeaders(){
  var h = { "Content-Type": "application/json" };
  if(SET.proto === "anthropic"){
    h["x-api-key"] = SET.key;
    h["anthropic-version"] = "2023-06-01";
    h["anthropic-dangerous-direct-browser-access"] = "true";
  }else{
    h["Authorization"] = "Bearer " + SET.key;
  }
  return h;
}

/* ---------------- 流解析 ---------------- */
function handleEvent(evt, st){
  var type = evt.type || "";
  if(SET.proto === "chat"){
    if(evt.error) throw new Error(evt.error.message || "接口返回错误");
    var ch = evt.choices && evt.choices[0];
    if(ch){
      var d = ch.delta || {};
      if(d.reasoning_content) st.think += d.reasoning_content;
      else if(typeof d.reasoning === "string") st.think += d.reasoning;
      if(typeof d.content === "string") st.text += d.content;
      else if(Array.isArray(d.content)){
        for(var i = 0; i < d.content.length; i++){ if(d.content[i].text) st.text += d.content[i].text; }
      }
      if(ch.finish_reason) st.done = true;
    }
    return;
  }
  if(SET.proto === "responses"){
    if(type === "response.output_text.delta" && evt.delta){ st.text += evt.delta; }
    else if((type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") && evt.delta){ st.think += evt.delta; }
    else if(type === "response.completed"){
      var o = (evt.response && evt.response.output) || [];
      if(!st.text){
        for(var a = 0; a < o.length; a++){
          var cs = o[a].content || [];
          for(var b = 0; b < cs.length; b++){ if(cs[b].type === "output_text") st.text += cs[b].text || ""; }
        }
      }
      st.done = true;
    }else if(type === "error" || evt.error){
      throw new Error((evt.error && evt.error.message) || "接口返回错误");
    }
    return;
  }
  if(type === "content_block_delta" && evt.delta){
    if(evt.delta.type === "thinking_delta") st.think += evt.delta.thinking || "";
    else if(evt.delta.type === "text_delta") st.text += evt.delta.text || "";
  }else if(type === "message_delta"){
    st.done = true;
  }else if(type === "error"){
    throw new Error((evt.error && evt.error.message) || "接口返回错误");
  }
}
function parseWholeJSON(obj, st){
  var i, a, b, cs;
  if(SET.proto === "chat"){
    var m = obj.choices && obj.choices[0] && obj.choices[0].message;
    if(m){
      if(m.reasoning_content) st.think += m.reasoning_content;
      if(typeof m.content === "string") st.text += m.content;
      else if(Array.isArray(m.content)){
        for(i = 0; i < m.content.length; i++){ if(m.content[i].text) st.text += m.content[i].text; }
      }
    }
  }else if(SET.proto === "responses"){
    a = obj.output || [];
    for(i = 0; i < a.length; i++){
      cs = a[i].content || [];
      for(b = 0; b < cs.length; b++){
        if(cs[b].type === "output_text") st.text += cs[b].text || "";
        if(cs[b].type === "reasoning_text") st.think += cs[b].text || "";
      }
    }
  }else{
    cs = obj.content || [];
    for(i = 0; i < cs.length; i++){
      if(cs[i].type === "text") st.text += cs[i].text || "";
      if(cs[i].type === "thinking") st.think += cs[i].thinking || "";
    }
  }
}

/* ---------------- 发送 ---------------- */
function HttpError(status, body){
  this.name = "HttpError";
  this.status = status;
  this.body = body;
  this.message = "HTTP " + status;
}
HttpError.prototype = Object.create(Error.prototype);

function explainError(err){
  if(err && err.name === "HttpError"){
    var b = String(err.body || "").slice(0, 700);
    var hint = "";
    if(err.status === 401 || err.status === 403) hint = "API Key 不对，或者这个 Key 没有该模型的权限。";
    else if(err.status === 404) hint = "地址或模型名不对：检查「接口地址」是不是少了 /v1，模型名是否拼对，协议是否选对。";
    else if(err.status === 400) hint = "参数不被接受：多半是协议选错，或模型不支持图片 / 思考模式。";
    else if(err.status === 429) hint = "请求太频繁，或者余额不足。";
    else if(err.status >= 500) hint = "对方服务器出错，等一会儿再试。";
    return "<b>请求失败（HTTP " + err.status + "）</b><br>" + esc(hint) + "<br><code>" + esc(b) + "</code>";
  }
  var m = String((err && err.message) || err);
  if(m.indexOf("Failed to fetch") >= 0 || m.indexOf("NetworkError") >= 0 || m.indexOf("Load failed") >= 0){
    return "<b>连不上接口</b><br>常见原因：<br>1）这个接口不允许浏览器直接调用（跨域被拦）；<br>" +
      "2）接口地址写错，或者断网；<br>3）HTTPS 页面去请求 HTTP 地址被浏览器拦截。<br><br>" +
      "办法：设置里把「跨域代理」选成本机代理，再按 README 启动 <code>proxy/server.py</code>。";
  }
  return "<b>出错了</b><br>" + esc(m);
}
function setSendState(on){
  var b = $("send");
  if(on){ b.classList.add("stop"); b.textContent = "■"; b.title = "停止"; }
  else{ b.classList.remove("stop"); b.textContent = "↑"; b.title = "发送"; }
}
function stopStream(){ if(abortCtl){ try{ abortCtl.abort(); }catch(e){} } }

async function send(){
  if(streaming){ stopStream(); return; }
  var text = $("ta").value.trim();
  if(!text && !atts.length) return;
  if(!configured()){
    toast("先去「设置」填接口地址、API Key 和模型名");
    openSet();
    return;
  }

  var c = curChat();
  if(!c){
    c = { id: uid(), title: "", createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    chats.unshift(c);
    curId = c.id;
  }

  var um = { role: "user", text: text, imgs: atts.slice(), ts: Date.now() };
  c.messages.push(um);
  if(!c.title) c.title = (text || "图片提问").slice(0, 26);
  c.updatedAt = Date.now();

  atts = [];
  renderAtts();
  $("ta").value = "";
  autoGrow();
  $("welcome").style.display = "none";
  $("scroll").style.display = "block";
  $("msgs").appendChild(addMsgNode("user", um.text, um.imgs));
  $("chatTitle").textContent = c.title;
  scrollBottom(true);
  await dbPutSafe(c);
  renderList();

  var aiNode = addMsgNode("assistant", "", null, null);
  $("msgs").appendChild(aiNode);
  var bub = aiNode.querySelector(".bubble");
  var mdBox = document.createElement("div");
  mdBox.className = "md";
  bub.appendChild(mdBox);
  var cursor = document.createElement("span");
  cursor.className = "cur";
  bub.appendChild(cursor);
  scrollBottom(true);

  var st = { text: "", think: "", done: false };
  streaming = true;
  abortCtl = (typeof AbortController !== "undefined") ? new AbortController() : null;
  setSendState(true);
  $("tipLine").textContent = "正在思考…（点红色按钮可以停下来）";

  var thinkEl = null, thinkIn = null, thinkSum = null;
  var lastPaint = 0;
  var prevTextLen = 0, prevThinkLen = 0;
  var blockCache = [];        // 已完成渲染的 markdown 块，避免全量重排
  var renderTimer = null;

  function ensureThink(){
    if(st.think && !thinkEl){
      thinkEl = document.createElement("details");
      thinkEl.className = "think";
      thinkSum = document.createElement("summary");
      thinkSum.innerHTML = '<span class="arw">▶</span>思考过程 <span class="live">· 正在思考</span>';
      thinkEl.appendChild(thinkSum);
      thinkIn = document.createElement("div");
      thinkIn.className = "in";
      thinkEl.appendChild(thinkIn);
      bub.insertBefore(thinkEl, mdBox);
    }
  }

  /* 把已结束的段落（以空行分隔）渲染成 HTML 并缓存；
     只有最后一个还"没写完"的块需要每次重算。这样回复再长，
     每帧也只重新解析末尾那一小段。 */
  /* 流式时末尾常有写了一半的公式（\$\frac{1}{ 这种），
     直接渲染会露出源码。这里把最后一个未闭合的 $ 之后的内容先藏起来。 */
  function trimOpenMath(txt){
    var lastOpen = -1;
    for(var i = 0; i < txt.length; i++){
      if(txt.charAt(i) === "$"){
        // 成对吃掉 $ 或 $
        if(txt.charAt(i+1) === "$"){
          var close = txt.indexOf("$", i + 2);
          if(close < 0){ lastOpen = i; break; }
          i = close + 1;
        }else{
          var c2 = txt.indexOf("$", i + 1);
          if(c2 < 0){ lastOpen = i; break; }
          i = c2;
        }
      }
    }
    return lastOpen < 0 ? txt : txt.slice(0, lastOpen);
  }

  function renderIncremental(fullRaw){
    var full = trimOpenMath(fullRaw);
    var parts = full.split(/\n{2,}/);
    var done = parts.slice(0, -1);
    var tail = parts.length ? parts[parts.length - 1] : "";

    // 保护：理论上 done 只会变多；万一变少（公式跨块等），整体重建
    if(done.length < blockCache.length){
      mdBox.innerHTML = "";
      blockCache = [];
      mdBox.__tail = null;
    }
    for(var i = blockCache.length; i < done.length; i++){
      var el = document.createElement("div");
      el.className = "blk";
      el.innerHTML = md(done[i]);
      mdBox.appendChild(el);
      blockCache.push({ text: done[i], el: el });
    }
    // 末尾活动块
    if(!mdBox.__tail){
      mdBox.__tail = document.createElement("div");
      mdBox.__tail.className = "blk";
      mdBox.appendChild(mdBox.__tail);
    }
    mdBox.__tail.innerHTML = md(tail);
  }

  function paint(force){
    var t = Date.now();
    if(!force && t - lastPaint < 70) return;
    lastPaint = t;
    ensureThink();

    // 思考过程：只追加，不整体替换
    if(thinkIn && st.think.length !== prevThinkLen){
      thinkIn.appendChild(document.createTextNode(st.think.slice(prevThinkLen)));
      prevThinkLen = st.think.length;
    }

    if(st.text.length !== prevTextLen){
      renderIncremental(st.text);
      prevTextLen = st.text.length;
    }
    if(force && st.text) renderMath(mdBox);
    scrollBottom(!!force);
  }

  try{
    var msgs = buildHistory(c);
    var body = buildBody(c, msgs);
    var url = withProxy(endpoint(SET.proto));
    var opt = { method: "POST", headers: buildHeaders(), body: JSON.stringify(body) };
    if(abortCtl) opt.signal = abortCtl.signal;

    var resp = await fetch(url, opt);
    if(!resp.ok){
      var txt = "";
      try{ txt = await resp.text(); }catch(e2){}
      throw new HttpError(resp.status, txt);
    }

    var ctype = resp.headers.get("content-type") || "";
    if(ctype.indexOf("text/event-stream") < 0 && ctype.indexOf("json") >= 0){
      var obj = await resp.json();
      parseWholeJSON(obj, st);
      paint(true);
    }else{
      var reader = resp.body.getReader();
      var dec = new TextDecoder("utf-8");
      var buf = "";
      var EOL = String.fromCharCode(10);
      var CR = String.fromCharCode(13);
      while(true){
        var rd = await reader.read();
        if(rd.done) break;
        buf += dec.decode(rd.value, { stream: true });
        var cut;
        while((cut = buf.search(/\r?\n\r?\n/)) >= 0){
          var raw = buf.slice(0, cut);
          var sep = buf.substr(cut, 4) === CR + EOL + CR + EOL ? 4 : 2;
          buf = buf.slice(cut + sep);
          var evLines = raw.split(/\r?\n/);
          var dataArr = [];
          for(var li = 0; li < evLines.length; li++){
            var ln = evLines[li];
            if(ln.indexOf("data:") === 0){
              var val = ln.slice(5);
              if(val.charAt(0) === " ") val = val.slice(1);
              dataArr.push(val);
            }
          }
          if(!dataArr.length) continue;
          var payload = dataArr.join(EOL);
          if(payload === "[DONE]") continue;
          var evt = null;
          try{ evt = JSON.parse(payload); }catch(e3){ continue; }
          handleEvent(evt, st);
          paint(false);
        }
      }
      paint(true);
    }

    if(cursor) cursor.remove();
    if(thinkSum) thinkSum.innerHTML = '<span class="arw">▶</span>思考过程';
    if(thinkEl) thinkEl.open = false;

    if(!String(st.text).trim()){
      st.text = String(st.think).trim()
        ? "（这次只返回了思考内容，没有正式回复。可能是「单次输出上限」太小，去设置里调大一点。）"
        : "（没有收到内容，检查模型名和协议是否匹配。）";
      mdBox.innerHTML = md(st.text);
    }

    c.messages.push({ role: "assistant", text: st.text, think: st.think, ts: Date.now() });
    c.updatedAt = Date.now();
    await dbPutSafe(c);
    renderList();
    $("chatTitle").textContent = c.title;
  }catch(err){
    if(cursor) cursor.remove();
    if(err && err.name === "AbortError"){
      if(String(st.text).trim()){
        c.messages.push({ role: "assistant", text: st.text, think: st.think, ts: Date.now() });
        c.updatedAt = Date.now();
        await dbPutSafe(c);
        if(thinkSum) thinkSum.innerHTML = '<span class="arw">▶</span>思考过程';
        if(thinkEl) thinkEl.open = false;
      }else{
        mdBox.innerHTML = '<div class="err">已停止。</div>';
      }
    }else{
      mdBox.innerHTML = '<div class="err">' + explainError(err) + "</div>";
    }
  }finally{
    streaming = false;
    abortCtl = null;
    setSendState(false);
    $("tipLine").textContent = "内容由 AI 生成，重要结论请自己再核对一遍";
    scrollBottom(true);
  }
}

/* ---------------- 图片附件 ---------------- */
function renderAtts(){
  var row = $("attachRow");
  row.innerHTML = "";
  for(var i = 0; i < atts.length; i++){
    var d = document.createElement("div");
    d.className = "thumb";
    d.innerHTML = '<img src="' + atts[i] + '"><button class="rm" data-i="' + i + '">×</button>';
    row.appendChild(d);
  }
}
function addFiles(files){
  if(!files || !files.length) return;
  var arr = [];
  for(var i = 0; i < files.length; i++) arr.push(files[i]);
  if(!atts.length && arr.length > 6) toast("一次最多 6 张图");
  var room = Math.max(0, 6 - atts.length);
  arr.slice(0, room).forEach(function(f){
    if(f.type && f.type.indexOf("image/") !== 0) return;
    compress(f, 1600, 0.86, function(dataUrl){ atts.push(dataUrl); renderAtts(); });
  });
}
function compress(file, maxSide, quality, cb){
  var fr = new FileReader();
  fr.onload = function(){
    var img = new Image();
    img.onload = function(){
      var w = img.width, h = img.height;
      var sc = Math.min(1, maxSide / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * sc)), chh = Math.max(1, Math.round(h * sc));
      var cv = document.createElement("canvas");
      cv.width = cw; cv.height = chh;
      var ctx = cv.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, cw, chh);
      ctx.drawImage(img, 0, 0, cw, chh);
      cb(cv.toDataURL("image/jpeg", quality));
    };
    img.onerror = function(){ cb(fr.result); };
    img.src = fr.result;
  };
  fr.readAsDataURL(file);
}

/* ---------------- 导出 ---------------- */
function dl(name, content, mime){
  var blob = new Blob([content], { type: mime || "text/plain;charset=utf-8" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
function safeName(s){
  return String(s || "对话").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40) || "对话";
}
function toMarkdown(c){
  var out = ["# " + (c.title || "对话"), ""];
  out.push("导出时间：" + new Date().toLocaleString() + "　模型：" + (SET.model || "未设置"));
  out.push("");
  (c.messages || []).forEach(function(m){
    if(m.role === "system") return;
    out.push("## " + (m.role === "user" ? "我" : (SET.tutor || "AI 老师")));
    if(m.text) out.push(m.text);
    if(m.imgs && m.imgs.length) out.push("（附图 " + m.imgs.length + " 张）");
    if(m.think) out.push("", "> 思考过程：", "> " + String(m.think).replace(/\n/g, "\n> "));
    out.push("");
  });
  return out.join("\n");
}
function toTxt(c){
  var out = [c.title || "对话", ""];
  (c.messages || []).forEach(function(m){
    if(m.role === "system") return;
    out.push(m.role === "user" ? "【我】" : "【" + (SET.tutor || "AI 老师") + "】");
    out.push(m.text || "");
    if(m.imgs && m.imgs.length) out.push("（附图 " + m.imgs.length + " 张）");
    out.push("");
  });
  return out.join("\n");
}
function toSingleHTML(c){
  var body = "";
  (c.messages || []).forEach(function(m){
    if(m.role === "system") return;
    body += '<div class="m ' + (m.role === "user" ? "me" : "") + '"><div class="who">' +
      esc(m.role === "user" ? "我" : (SET.tutor || "AI 老师")) + '</div><div class="b">';
    if(m.imgs && m.imgs.length){
      m.imgs.forEach(function(d){ body += '<img src="' + d + '">'; });
    }
    if(m.text) body += esc(m.text).replace(/\n/g, "<br>");
    body += "</div></div>";
  });
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>" + esc(c.title || "对话") + "</title><style>" +
    "body{background:#14161b;color:#e8ecf4;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;line-height:1.8;padding:24px;max-width:780px;margin:0 auto}" +
    ".m{margin-bottom:18px}.who{font-size:12px;color:#8a93a6;margin-bottom:6px}.b{background:#1d212a;border-radius:12px;padding:12px 15px}" +
    ".me .b{background:#2b3550}.me .who{text-align:right}.b img{max-width:100%;border-radius:10px;display:block;margin:8px 0}" +
    "</style></head><body><h2>" + esc(c.title || "对话") + "</h2>" + body + "</body></html>";
}

/* ---------------- 设置面板 ---------------- */
function fillSet(){
  $("fBase").value = SET.base || "";
  $("fKey").value = SET.key || "";
  $("fModel").value = SET.model || "";
  $("fProto").value = SET.proto || "chat";
  $("fCtx").value = SET.ctxK || 128;
  $("fMax").value = SET.maxK || 8;
  $("fTemp").value = (SET.temp === null ? "" : SET.temp);
  $("fProxy").value = SET.proxy || "";
  segSet("segThink", SET.think || "off");
  updateChip();
}
function segSet(id, v){
  var btns = $(id).querySelectorAll("button");
  for(var i = 0; i < btns.length; i++) btns[i].classList.toggle("on", btns[i].dataset.v === v);
}
function segGet(id){
  var b = $(id).querySelector("button.on");
  return b ? b.dataset.v : "off";
}
/* 记录打开面板时的快照，用来判断有没有未保存的改动 */
var setSnap = "";
var promptSnap = "";
function formSig(){
  return JSON.stringify([
    $("fBase").value, $("fKey").value, $("fModel").value, $("fProto").value,
    $("fCtx").value, $("fMax").value, $("fTemp").value, $("fProxy").value,
    segGet("segThink")
  ]);
}
function setDirty(){ return setSnap !== "" && formSig() !== setSnap; }
function promptDirty(){
  return promptSnap !== "" &&
    ($("fPrompt").value !== promptSnap.prompt || $("fTutor").value !== promptSnap.tutor);
}
function openSet(){
  fillSet();
  setSnap = formSig();
  $("setStatus").textContent = "";
  $("mSet").classList.add("on");
  closeSide();
}
function collectSet(){
  return {
    base: $("fBase").value.trim(),
    key: $("fKey").value.trim(),
    model: $("fModel").value.trim(),
    proto: $("fProto").value,
    ctxK: Math.max(1, Math.min(2000, Number($("fCtx").value) || 128)),
    maxK: Math.max(1, Math.min(128, Number($("fMax").value) || 8)),
    temp: $("fTemp").value === "" ? null : Math.max(0, Math.min(2, Number($("fTemp").value))),
    think: segGet("segThink"),
    proxy: $("fProxy").value,
    prompt: SET.prompt,
    tutor: SET.tutor
  };
}
var THINK_NAME = { off: "关", minimal: "最少", low: "低", medium: "中", high: "高", xhigh: "较高", max: "最高" };
function updateChip(){
  var chip = $("modelChip");
  if(configured()){
    chip.classList.remove("off");
    $("modelName").textContent = SET.model;
  }else{
    chip.classList.add("off");
    $("modelName").textContent = "未配置";
  }
  var b = $("btnThink");
  b.textContent = "💭 思考·" + (THINK_NAME[SET.think] || "关");
  b.classList.toggle("on", SET.think !== "off");
}
async function testConn(){
  var st = $("setStatus");
  var save = collectSet();
  if(!save.base || !save.key || !save.model){
    st.innerHTML = '<span style="color:#f87171">地址、Key、模型名都要填</span>';
    return;
  }
  st.innerHTML = "正在测试…";
  var old = SET;
  SET = save;
  try{
    var body;
    if(SET.proto === "chat"){
      body = { model: SET.model, messages: [{ role: "user", content: "只回复两个字：可以" }], max_tokens: 16, stream: false };
    }else if(SET.proto === "responses"){
      body = { model: SET.model, input: [{ role: "user", content: [{ type: "input_text", text: "只回复两个字：可以" }] }], max_output_tokens: 64, stream: false };
    }else{
      body = { model: SET.model, max_tokens: 32, messages: [{ role: "user", content: [{ type: "text", text: "只回复两个字：可以" }] }] };
    }
    var resp = await fetch(withProxy(endpoint(SET.proto)), { method: "POST", headers: buildHeaders(), body: JSON.stringify(body) });
    if(!resp.ok){
      var t = await resp.text();
      st.innerHTML = '<span style="color:#f87171">失败 HTTP ' + resp.status + "</span> " + esc(String(t).slice(0, 200));
      SET = old;
      return;
    }
    var j = await resp.json();
    var out = "";
    if(SET.proto === "chat") out = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
    else if(SET.proto === "responses") (j.output || []).forEach(function(o){ (o.content || []).forEach(function(cc){ if(cc.type === "output_text") out += cc.text; }); });
    else out = (j.content || []).map(function(cc){ return cc.text || ""; }).join("");
    st.innerHTML = '<span style="color:#4ade80">连接成功 ✓</span> 模型回复：' + esc(String(out).slice(0, 40) || "（空）");
  }catch(e){
    st.innerHTML = '<span style="color:#f87171">失败</span> ' + esc(String(e.message || e)) +
      (String(e.message || e).indexOf("fetch") >= 0 ? "<br>多半是跨域，试试本机代理。" : "");
  }finally{
    SET = old;
  }
}

/* ---------------- 输入框 ---------------- */
function autoGrow(){
  var ta = $("ta");
  if(!ta) return;
  ta.style.height = "auto";
  ta.style.height = Math.min(180, ta.scrollHeight) + "px";
}
function closeSide(){ $("side").classList.remove("open"); $("mask").classList.remove("on"); }

/* ---------------- 获取模型列表 ---------------- */
var allModels = [];
var modelsLoading = false;

function modelsEndpoint(proto){
  var b = normBase(SET.base);
  if(proto === "anthropic") return b + "/models";
  // OpenAI 兼容的 /models 一律挂在 base 上
  return b + "/models";
}
function modelsHeaders(proto, key){
  var h = { "Content-Type": "application/json" };
  if(proto === "anthropic"){
    h["x-api-key"] = key;
    h["anthropic-version"] = "2023-06-01";
    h["anthropic-dangerous-direct-browser-access"] = "true";
  }else{
    h["Authorization"] = "Bearer " + key;
  }
  return h;
}
/* 从各家返回结构里把模型 id 抠出来 */
function parseModels(j){
  var out = [];
  function push(id, extra){
    if(!id || typeof id !== "string") return;
    out.push({ id: id, extra: extra || "" });
  }
  var arr = null;
  if(Array.isArray(j)) arr = j;
  else if(j && Array.isArray(j.data)) arr = j.data;
  else if(j && Array.isArray(j.models)) arr = j.models;
  if(!arr) return out;

  for(var i = 0; i < arr.length; i++){
    var it = arr[i];
    if(typeof it === "string"){ push(it); continue; }
    if(!it || typeof it !== "object") continue;
    var id = it.id || it.name || it.model || it.model_name || it.slug;
    if(!id) continue;
    // Anthropic 的 name 是 "claude-3-5-sonnet-20241022" 这种，id 也是，优先 id
    var extra = it.display_name || it.displayName || it.owned_by || "";
    if(it.type && !extra) extra = it.type;
    push(String(id), String(extra));
  }
  // 去重
  var seen = {}, uniq = [];
  for(var k = 0; k < out.length; k++){
    if(seen[out[k].id]) continue;
    seen[out[k].id] = 1;
    uniq.push(out[k]);
  }
  uniq.sort(function(a, b){ return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
  return uniq;
}
async function fetchModels(base, key, proto, proxy){
  var url = (function(){
    var b = normBase(base);
    return b + "/models";
  })();
  var full = url;
  var p = String(proxy || "").trim().replace(/\/+$/, "");
  if(p) full = p + "/proxy?u=" + encodeURIComponent(url);

  var resp = await fetch(full, { method: "GET", headers: modelsHeaders(proto, key) });
  if(!resp.ok){
    var t = "";
    try{ t = await resp.text(); }catch(e){}
    var err = new Error("HTTP " + resp.status);
    err.status = resp.status;
    err.body = t;
    throw err;
  }
  var j = await resp.json();
  return parseModels(j);
}
function renderModels(kw){
  var box = $("modelList");
  var q = String(kw || "").trim().toLowerCase();
  var arr = allModels.filter(function(m){
    return !q || m.id.toLowerCase().indexOf(q) >= 0 || (m.extra || "").toLowerCase().indexOf(q) >= 0;
  });
  var cur = ($("fModel").value || "").trim();
  if(!arr.length){
    box.innerHTML = '<div class="mempty">' + (q ? "没有匹配的模型" : "这个接口没返回模型列表<br>可以直接在上面手填模型名") + "</div>";
    return;
  }
  var html = "";
  for(var i = 0; i < arr.length; i++){
    var m = arr[i];
    html += '<div class="mitem' + (m.id === cur ? " on" : "") + '" data-id="' + esc(m.id) + '">' +
      '<span class="nm">' + esc(m.id) + "</span>" +
      (m.extra ? '<span class="tag">' + esc(m.extra) + "</span>" : "") +
      "</div>";
  }
  box.innerHTML = html;
}
function pickModel(id){
  $("fModel").value = id;
  $("mModels").classList.remove("on");
  toast("已选择：" + id + "（记得点「保存」）");
}
async function doGetModels(){
  if(modelsLoading) return;
  var base = $("fBase").value.trim();
  var key = $("fKey").value.trim();
  var proto = $("fProto").value;
  var proxy = $("fProxy").value;
  if(!base){ toast("先填接口地址"); $("fBase").focus(); return; }
  if(!key){ toast("先填 API Key"); $("fKey").focus(); return; }

  modelsLoading = true;
  var btn = $("btnGetModels");
  var oldTxt = btn.textContent;
  btn.disabled = true;
  btn.textContent = "获取中…";

  $("mModels").classList.add("on");
  $("modelSearch").value = "";
  $("modelCount").textContent = "…";
  $("modelsHint").textContent = "正在向 " + normBase(base) + "/models 请求…";
  $("modelList").innerHTML = '<div class="mempty">加载中…</div>';

  try{
    var list = await fetchModels(base, key, proto, proxy);
    allModels = list;
    modelsLoading = false;
    btn.disabled = false;
    btn.textContent = oldTxt;

    if(!list.length){
      $("modelCount").textContent = "0";
      $("modelsHint").textContent = "接口返回成功，但里面没有模型。这个服务可能不支持 /models，直接手填模型名吧。";
      renderModels("");
      return;
    }
    $("modelCount").textContent = list.length + " 个";
    $("modelsHint").textContent = "点一个就用它，当前已选的会高亮。共 " + list.length + " 个。";
    renderModels("");
  }catch(err){
    modelsLoading = false;
    btn.disabled = false;
    btn.textContent = oldTxt;
    $("modelCount").textContent = "失败";
    var msg = "获取失败：";
    if(err && err.status === 401 || err && err.status === 403){
      msg += "API Key 不对，或者没有权限。";
    }else if(err && err.status === 404){
      msg += "这个地址没有 /models 接口，换一种协议试试，或者直接手填模型名。";
    }else if(err && err.status){
      msg += "HTTP " + err.status + "。" + String(err.body || "").slice(0, 160);
    }else{
      msg += "连不上（多半是跨域）。把「跨域代理」选成本机代理再试，或者直接手填模型名。";
    }
    $("modelsHint").innerHTML = '<span style="color:#f87171">' + esc(msg) + "</span>";
    $("modelList").innerHTML = '<div class="mempty">没有取到列表，可以关闭后直接手填模型名</div>';
  }
}

/* ---------------- 事件绑定 ---------------- */
function bind(){
  $("btnMenu").onclick = function(){ $("side").classList.add("open"); $("mask").classList.add("on"); };
  $("mask").onclick = closeSide;
  $("btnNew").onclick = newChat;
  $("btnHome").onclick = function(){ location.href = "index.html"; };
  $("q").oninput = renderList;

  $("chatlist").onclick = function(e){
    var del = e.target.closest("[data-del]");
    if(del){
      e.stopPropagation();
      var id = del.getAttribute("data-del");
      var c = null;
      for(var i = 0; i < chats.length; i++){ if(chats[i].id === id) c = chats[i]; }
      if(!c) return;
      if(!confirm("删除对话「" + (c.title || "新对话") + "」？删了就找不回来了。")) return;
      dbDel(id).then(function(){
        chats = chats.filter(function(x){ return x.id !== id; });
        if(curId === id) newChat();
        renderList();
        toast("已删除");
      });
      return;
    }
    var it = e.target.closest(".citem");
    if(it) openChat(it.getAttribute("data-id"));
  };

  var ta = $("ta");
  ta.addEventListener("input", autoGrow);
  ta.addEventListener("keydown", function(e){
    if(e.key === "Enter" && !e.shiftKey && !e.isComposing){ e.preventDefault(); send(); }
  });
  ta.addEventListener("focus", function(){ $("cwrap").classList.add("focus"); });
  ta.addEventListener("blur", function(){ $("cwrap").classList.remove("focus"); });
  ta.addEventListener("paste", function(e){
    var items = (e.clipboardData && e.clipboardData.items) || [];
    var fs = [];
    for(var i = 0; i < items.length; i++){
      if(items[i].type && items[i].type.indexOf("image") === 0){
        var f = items[i].getAsFile();
        if(f) fs.push(f);
      }
    }
    if(fs.length){ e.preventDefault(); addFiles(fs); toast("已添加图片"); }
  });

  $("send").onclick = send;
  $("btnImg").onclick = function(){ $("fileIn").click(); };
  $("fileIn").onchange = function(){ addFiles(this.files); this.value = ""; };
  $("btnThink").onclick = function(){
    var i = THINK_LEVELS.indexOf(SET.think || "off");
    if(i < 0) i = 0;
    SET.think = THINK_LEVELS[(i + 1) % THINK_LEVELS.length];
    saveSet();
    updateChip();
    toast("思考模式：" + THINK_NAME[SET.think]);
  };
  $("attachRow").onclick = function(e){
    var b = e.target.closest(".rm");
    if(b){ atts.splice(parseInt(b.getAttribute("data-i"), 10), 1); renderAtts(); }
  };

  var cw = $("cwrap");
  var dragOn = ["dragenter", "dragover"];
  var dragOff = ["dragleave", "drop"];
  dragOn.forEach(function(ev){ cw.addEventListener(ev, function(e){ e.preventDefault(); cw.classList.add("drag"); }); });
  dragOff.forEach(function(ev){ cw.addEventListener(ev, function(e){ e.preventDefault(); cw.classList.remove("drag"); }); });
  cw.addEventListener("drop", function(e){ if(e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });
  window.addEventListener("dragover", function(e){ e.preventDefault(); });
  window.addEventListener("drop", function(e){ if(e.target === document.body) e.preventDefault(); });

  $("msgs").onclick = function(e){
    var b = e.target.closest("[data-act]");
    if(!b) return;
    var node = b.closest(".msg");
    var idx = Array.prototype.indexOf.call($("msgs").children, node);
    var c = curChat();
    if(!c) return;
    var real = [];
    for(var i = 0; i < c.messages.length; i++){ if(c.messages[i].role !== "system") real.push(c.messages[i]); }
    var mm = real[idx];
    if(!mm) return;
    if(b.getAttribute("data-act") === "copy"){
      var txt = mm.text || "";
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(txt).then(function(){ toast("已复制"); }, function(){ toast("复制失败，请手动选择"); });
      }else{ toast("这个浏览器不支持自动复制"); }
    }else{
      regen(idx);
    }
  };

  $("btnSetting").onclick = openSet;
  $("btnTopSetting").onclick = openSet;
  $("modelChip").onclick = openSet;
  // 设置弹层：只能点「关闭」或「保存」退出，点空白处不关闭（避免误触丢失编辑内容）
  $("setClose").onclick = function(){
    if(setDirty() && !confirm("设置改了还没保存，确实要关闭吗？\n点「取消」可以回去继续编辑。")) return;
    $("mSet").classList.remove("on");
  };
  $("setSave").onclick = function(){
    SET = collectSet();
    saveSet();
    updateChip();
    setSnap = "";
    $("mSet").classList.remove("on");
    toast("设置已保存到本机");
  };
  $("setTest").onclick = testConn;

  // 获取模型列表
  $("btnGetModels").onclick = doGetModels;
  $("modelsClose").onclick = function(){ $("mModels").classList.remove("on"); };
  $("modelsCancel").onclick = function(){ $("mModels").classList.remove("on"); };
  $("modelsRefresh").onclick = function(){ doGetModels(); };
  $("modelSearch").oninput = function(){ renderModels(this.value); };
  $("modelList").onclick = function(e){
    var it = e.target.closest(".mitem");
    if(it) pickModel(it.getAttribute("data-id"));
  };
  $("modelSearch").addEventListener("keydown", function(e){
    if(e.key === "Enter"){
      e.preventDefault();
      var first = $("modelList").querySelector(".mitem");
      if(first) pickModel(first.getAttribute("data-id"));
    }
  });
  $("setClear").onclick = function(){
    if(!confirm("清空全部对话记录？此操作不可恢复。")) return;
    dbClear().then(function(){
      chats = [];
      newChat();
      renderList();
      toast("已清空");
    });
  };
  $("segThink").onclick = function(e){
    var b = e.target.closest("button[data-v]");
    if(b){ segSet("segThink", b.getAttribute("data-v")); }
  };

  $("btnPrompt").onclick = function(){
    $("fPrompt").value = SET.prompt || DEFAULT_PROMPT;
    $("fTutor").value = SET.tutor || "AI 老师";
    promptSnap = { prompt: $("fPrompt").value, tutor: $("fTutor").value };
    $("mPrompt").classList.add("on");
    closeSide();
  };
  // 提示词弹层：同样只能手动关闭
  $("promptClose").onclick = function(){
    if(promptDirty() && !confirm("提示词改了还没保存，确实要关闭吗？\n点「取消」可以回去继续编辑。")) return;
    $("mPrompt").classList.remove("on");
  };
  $("promptSave").onclick = function(){
    SET.prompt = $("fPrompt").value;
    SET.tutor = $("fTutor").value.trim() || "AI 老师";
    saveSet();
    promptSnap = "";
    $("mPrompt").classList.remove("on");
    toast("已保存");
    var c = curChat();
    if(c) renderChat(c, false);
  };
  $("promptReset").onclick = function(){
    $("fPrompt").value = DEFAULT_PROMPT;
    toast("已恢复默认提示词，记得点保存");
  };

  $("btnExport").onclick = function(){ $("mExport").classList.add("on"); closeSide(); };
  $("expClose").onclick = function(){ $("mExport").classList.remove("on"); };

  $("expMd").onclick = function(){ var c = curChat(); if(!c){ toast("还没有对话"); return; } dl(safeName(c.title) + ".md", toMarkdown(c), "text/markdown;charset=utf-8"); };
  $("expTxt").onclick = function(){ var c = curChat(); if(!c){ toast("还没有对话"); return; } dl(safeName(c.title) + ".txt", toTxt(c)); };
  $("expJson").onclick = function(){
    dl("君意AI老师-对话备份-" + new Date().toISOString().slice(0, 10) + ".json",
      JSON.stringify({ version: 1, exportedAt: Date.now(), settings: SET, chats: chats }, null, 2),
      "application/json;charset=utf-8");
  };
  $("expImg").onclick = function(){
    var c = curChat(); if(!c){ toast("还没有对话"); return; }
    dl(safeName(c.title) + ".html", toSingleHTML(c), "text/html;charset=utf-8");
  };

  $("quickCards").onclick = function(e){
    var q = e.target.closest(".qcard");
    if(!q) return;
    $("ta").value = q.getAttribute("data-q");
    autoGrow();
    $("ta").focus();
  };

  document.addEventListener("keydown", function(e){
    if(e.key === "Escape"){
      // 设置和提示词是编辑页，按 Esc 不关闭，只能点「关闭」或「保存」
      if($("mSet").classList.contains("on") || $("mPrompt").classList.contains("on") || $("mModels").classList.contains("on")){
        toast("编辑中，点「关闭」或「保存」才会退出");
        return;
      }
      $("mExport").classList.remove("on");
      closeSide();
    }
    if((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")){ e.preventDefault(); newChat(); }
  });

  window.addEventListener("beforeunload", function(e){
    if(streaming){ e.preventDefault(); e.returnValue = ""; }
  });
}

/* 重新生成 */
async function regen(idx){
  var c = curChat();
  if(!c || streaming) return;
  var real = [], map = [];
  for(var i = 0; i < c.messages.length; i++){
    if(c.messages[i].role !== "system"){ real.push(c.messages[i]); map.push(i); }
  }
  var target = real[idx];
  if(!target) return;
  var pos = map[idx];
  if(target.role === "assistant" && pos > 0 && c.messages[pos - 1].role === "user") pos = pos - 1;
  c.messages = c.messages.slice(0, pos + 1);
  var last = c.messages[c.messages.length - 1];
  if(!last || last.role !== "user") return;
  var txt = last.text, im = last.imgs;
  c.messages.pop();
  c.updatedAt = Date.now();
  await dbPutSafe(c);
  renderChat(c, false);
  $("ta").value = txt || "";
  atts = (im || []).slice();
  renderAtts();
  autoGrow();
  send();
}

/* ---------------- 启动 ---------------- */
async function boot(){
  SET = loadSet();
  bind();
  updateChip();
  autoGrow();
  try{
    db = await openDB();
    chats = await dbAll();
    sortChats();
  }catch(e){
    toast("浏览器不支持本地存储，对话可能无法保存");
    chats = [];
  }
  renderList();
  if(!configured()){
    setTimeout(function(){ toast("先点右上角「设置」填好接口再开始", 3200); }, 700);
  }
}
document.addEventListener("DOMContentLoaded", boot);

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
君意 · AI 老师 本地小代理
=========================
作用有两个：
1) 把网页里的请求转发到真正的 API 地址，绕开浏览器跨域（CORS）限制；
2) 顺便把网页本身也用 http:// 提供出来，双击 html 直接打开时
   有些浏览器会禁用 IndexedDB / 剪贴板，跑在 http 下更稳。

用法（在本文件所在目录的上一级执行）：
    py -X utf8 proxy/server.py
然后浏览器打开： http://127.0.0.1:8787/ai.html

代理只监听 127.0.0.1，只转发你在网页里填的那个地址，不保存任何内容。
"""

import http.client
import json
import mimetypes
import os
import socket
import ssl
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = int(os.environ.get("JY_PORT", "8787"))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host",
    "content-length", "content-encoding", "accept-encoding",
}


def log(msg):
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "JYProxy/1.0"

    # ---------- 公共 ----------
    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Max-Age", "86400")

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---------- 静态文件 ----------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/__ping":
            body = b'{"ok":true,"name":"jy-proxy"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.cors()
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/proxy":
            self.forward("GET", parsed)
            return
        self.serve_static(parsed.path)

    def do_HEAD(self):
        parsed = urllib.parse.urlparse(self.path)
        rel = urllib.parse.unquote(parsed.path)
        if rel in ("", "/"):
            rel = "/index.html"
        full = os.path.normpath(os.path.join(ROOT, rel.lstrip("/\\")))
        if not full.startswith(ROOT) or not os.path.isfile(full):
            self.send_error(404, "not found")
            return
        ctype, _ = mimetypes.guess_type(full)
        ctype = ctype or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(os.path.getsize(full)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def serve_static(self, path):
        rel = urllib.parse.unquote(path)
        if rel in ("", "/"):
            rel = "/index.html"
        full = os.path.normpath(os.path.join(ROOT, rel.lstrip("/\\")))
        if not full.startswith(ROOT):
            self.send_error(403, "forbidden")
            return
        if not os.path.isfile(full):
            self.send_error(404, "not found")
            return
        ctype, _ = mimetypes.guess_type(full)
        if ctype is None:
            ctype = "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        try:
            with open(full, "rb") as f:
                data = f.read()
        except OSError:
            self.send_error(500, "read error")
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    # ---------- 转发 ----------
    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/proxy":
            self.send_error(404, "unknown endpoint")
            return
        self.forward("POST", parsed)

    def forward(self, method, parsed):
        qs = urllib.parse.parse_qs(parsed.query)
        target = (qs.get("u") or [""])[0]
        if not target:
            self.send_error(400, "missing u")
            return
        tp = urllib.parse.urlparse(target)
        if tp.scheme not in ("http", "https") or not tp.netloc:
            self.send_error(400, "bad url")
            return

        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""

        hdrs = {}
        for k, v in self.headers.items():
            if k.lower() in HOP_HEADERS:
                continue
            hdrs[k] = v
        hdrs["Host"] = tp.netloc
        hdrs["Accept-Encoding"] = "identity"

        try:
            if tp.scheme == "https":
                ctx = ssl.create_default_context()
                conn = http.client.HTTPSConnection(tp.hostname, tp.port or 443, timeout=600, context=ctx)
            else:
                conn = http.client.HTTPConnection(tp.hostname, tp.port or 80, timeout=600)
            path = tp.path or "/"
            if tp.query:
                path += "?" + tp.query
            conn.request(method, path, body=body if method != "GET" else None, headers=hdrs)
            resp = conn.getresponse()
        except Exception as e:
            msg = json.dumps({"error": {"message": "proxy failed: %s" % e}}, ensure_ascii=False).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(msg)))
            self.cors()
            self.end_headers()
            self.wfile.write(msg)
            log("[proxy] 失败 %s -> %s" % (target, e))
            return

        log("[proxy] %s -> %s %s" % (target, resp.status, resp.getheader("Content-Type", "")))

        self.send_response(resp.status)
        for k, v in resp.getheaders():
            lk = k.lower()
            if lk in HOP_HEADERS:
                continue
            self.send_header(k, v)
        self.cors()
        self.send_header("Connection", "close")
        self.end_headers()

        try:
            while True:
                chunk = resp.read(2048)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            pass
        finally:
            try:
                conn.close()
            except Exception:
                pass
            self.close_connection = True


def main():
    if not os.path.isdir(ROOT):
        log("找不到网页目录: %s" % ROOT)
        return 1
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    log("=" * 52)
    log(" 君意 · AI 老师 本地代理已启动")
    log(" 网页地址:  http://%s:%d/ai.html" % (HOST, PORT))
    log(" 首页:      http://%s:%d/" % (HOST, PORT))
    log(" 代理接口:  http://%s:%d/proxy?u=<接口地址>" % (HOST, PORT))
    log(" 关闭窗口或按 Ctrl+C 结束")
    log("=" * 52)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("\n已停止")
    return 0


if __name__ == "__main__":
    sys.exit(main())

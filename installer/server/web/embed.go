// Package web 内嵌安装向导前端。
//
// 为什么用 embed 而不是把前端文件放到安装目录：安装器是单文件静态二进制，
// 前端必须跟着二进制走，否则「.run 解压后少了个 js」这种故障在现场无法自查。
// 前端只用原生 HTML/CSS/JS，**不引用任何 CDN**——现场无公网，CDN 引用会白屏。
package web

import "embed"

// FS 是内嵌的前端资源（index.html / app.js / style.css）。
//
//go:embed index.html app.js style.css
var FS embed.FS

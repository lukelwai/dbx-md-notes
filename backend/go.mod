// MD 笔记 —— DBX 插件侧车模块
//
// 依赖策略：零外部依赖。
// 官方 SDK 未发布到 Go 模块代理（go get 报 unknown revision），且其 go.mod 声明 go 1.22，
// 独立引入会让低版本工具链无法构建；因此把官方 sdk.go 原样 vendor 为 ./dbxsdk 包，
// 与本模块一起编译，仅需 Go 1.20+，且离线可构建。
module github.com/lwai/mdnotes

go 1.20

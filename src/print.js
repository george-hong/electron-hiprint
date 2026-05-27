"use strict";

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { pathToFileURL } = require("url");
const { printPdf, printPdfBlob, realPrint } = require("./pdf-print");
const { store } = require("../tools/utils");
const db = require("../tools/database");
const dayjs = require("dayjs");
const { v7: uuidv7 } = require("uuid");
const { jsPDF: jspdf } = require("jspdf");
const { imageSize } = require('image-size');

function getBase64ImageDimensions(base64WithPrefix) {
  try {
    // 移除data:image/*;base64,前缀（如果存在）
    let base64Data = base64WithPrefix;
    if (base64WithPrefix.startsWith('data:image')) {
      base64Data = base64WithPrefix.split(',')[1];
    }

    // 转换为buffer并获取尺寸
    const buffer = Buffer.from(base64Data, 'base64');
    const dimensions = imageSize(buffer);

    return {
      width: dimensions.width,
      height: dimensions.height
    };
  } catch (error) {
    console.error('Failed to get image dimensions:', error);
    return null;
  }
}

function resolveTargetPrinter(printers, preferredPrinter) {
  let printerName = preferredPrinter || "";
  if (!printerName) {
    printerName = (printers.find((item) => item.isDefault) || {}).name || "";
  }
  if (!printerName && printers.length) {
    printerName = printers[0].name;
  }
  const printerInfo = printers.find((item) => item.name === printerName);
  return {
    printerName,
    printerInfo,
    exists: Boolean(printerInfo),
  };
}

function normalizePrintUnit(unit) {
  const val = `${unit || "mm"}`.toLowerCase();
  if (["mm", "cm", "in", "inch", "px", "pt"].includes(val)) {
    return val === "inch" ? "in" : val;
  }
  return "mm";
}

function convertUnitToPx(value, unit) {
  const num = Number(value);
  if (!(num > 0)) return 0;
  const normalizedUnit = normalizePrintUnit(unit);
  switch (normalizedUnit) {
    case "mm":
      return Math.ceil((num * 96) / 25.4);
    case "cm":
      return Math.ceil((num * 96) / 2.54);
    case "in":
      return Math.ceil(num * 96);
    case "pt":
      return Math.ceil((num * 96) / 72);
    case "px":
      return Math.ceil(num);
    default:
      return Math.ceil((num * 96) / 25.4);
  }
}

function convertUnitToMicrons(value, unit) {
  const num = Number(value);
  if (!(num > 0)) return 0;
  const normalizedUnit = normalizePrintUnit(unit);
  switch (normalizedUnit) {
    case "mm":
      return Math.round(num * 1000);
    case "cm":
      return Math.round(num * 10000);
    case "in":
      return Math.round(num * 25400);
    case "pt":
      return Math.round((num / 72) * 25400);
    case "px":
      return Math.round((num / 96) * 25400);
    default:
      return Math.round(num * 1000);
  }
}

function getPrinterOfflineReason(printer) {
  if (!printer || typeof printer.status !== "number") {
    return "";
  }
  const status = Number(printer.status);
  if (process.platform === "win32") {
    const PRINTER_STATUS_OFFLINE = 0x80;
    const PRINTER_STATUS_NOT_AVAILABLE = 0x1000;
    if (status & PRINTER_STATUS_OFFLINE) {
      return `status=${status}(OFFLINE)`;
    }
    if (status & PRINTER_STATUS_NOT_AVAILABLE) {
      return `status=${status}(NOT_AVAILABLE)`;
    }
    return "";
  }
  // CUPS: 3-idle, 4-processing, 5-stopped
  if (status === 5) {
    return `status=${status}(STOPPED)`;
  }
  return "";
}

function normalizePrintFailureReason(failureReason) {
  const reason = `${failureReason || ""}`.trim();
  if (!reason) return "未知错误";
  if (/print job canceled/i.test(reason)) {
    return "打印机不在线";
  }
  return reason;
}

/**
 * @description: 创建打印窗口
 * @return {BrowserWindow} PRINT_WINDOW 打印窗口
 */
async function createPrintWindow() {
  const windowOptions = {
    width: 100, // 窗口宽度
    height: 100, // 窗口高度
    show: false, // 不显示
    webPreferences: {
      contextIsolation: false, // 设置此项为false后，才可在渲染进程中使用electron api
      nodeIntegration: true,
    },
    // 为窗口设置背景色可能优化字体模糊问题
    // https://www.electronjs.org/zh/docs/latest/faq#文字看起来很模糊这是什么原因造成的怎么解决这个问题呢
    backgroundColor: "#fff",
  };

  // 创建打印窗口
  PRINT_WINDOW = new BrowserWindow(windowOptions);

  // 加载打印渲染进程页面
  let printHtml = path.join(app.getAppPath(), "assets/print.html");
  PRINT_WINDOW.webContents.loadFile(printHtml);

  // 未打包时打开开发者工具
  // if (!app.isPackaged) {
  //   PRINT_WINDOW.webContents.openDevTools();
  // }

  // 绑定窗口事件
  initPrintEvent();

  return PRINT_WINDOW;
}

async function printHTMLByData(data, socket, logPrintResult, printer) {
  const tempHtmlDir = store.get("pdfPath") || os.tmpdir();
  fs.mkdirSync(tempHtmlDir, { recursive: true });
  const svgBatchStylePath = path.join(
    app.getAppPath(),
    "assets",
    "css",
    "print-lock.css",
  );
  const styleContent = fs.readFileSync(svgBatchStylePath, "utf8");
  const tempHtmlPath = path.join(tempHtmlDir, "batch-print.html");
  const targetStr = '<link rel="icon" href="/favicon.ico">';
  data.html = data.html.replace(
    targetStr,
    `${targetStr}<style>${styleContent}</style>`,
  );
  fs.writeFileSync(tempHtmlPath, data.html, "utf8");
  console.log(`[printHTMLByData] 临时Html文件: ${tempHtmlPath}`);
  const tempPrintWindow = new BrowserWindow({
    width: 800,
    height: 800,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
    },
    backgroundColor: "#fff",
  });

  const pageRanges =
    typeof data.pageRanges === "string" ? data.pageRanges : undefined;
  const printOptions = {
    silent: data.silent ?? true,
    printBackground: data.printBackground ?? true,
    deviceName: printer,
    color: data.color ?? true,
    margins: data.margins ?? {
      marginType: "none",
    },
    landscape: false,
    scaleFactor: data.scaleFactor ?? 100,
    pagesPerSheet: data.pagesPerSheet ?? 1,
    collate: data.collate ?? true,
    copies: data.copies ?? 1,
    pageRanges,
    duplexMode: data.duplexMode,
    dpi: data.dpi ?? 300,
    pageSize: data.pageSize,
  };

  try {
    await tempPrintWindow.loadURL(pathToFileURL(tempHtmlPath).href);

    // 等待页面完成渲染
    await tempPrintWindow.webContents.executeJavaScript(
      `new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      })`,
    );

    // 获取内容实际尺寸，调整窗口大小和纸张大小，避免打印内容过小
    const contentSize = await tempPrintWindow.webContents.executeJavaScript(
      `(() => {
        const papers = document.querySelectorAll('.hiprint-printPaper');
        if (!papers.length) {
          return { width: 0, height: 0, pageHeight: 0 };
        }
        let maxWidth = 0;
        let totalHeight = 0;
        let firstHeight = 0;
        papers.forEach(function(paper, i) {
          var rect = paper.getBoundingClientRect();
          maxWidth = Math.max(maxWidth, rect.width);
          totalHeight += rect.height;
          if (i === 0) {
            firstHeight = rect.height;
          }
        });
        return {
          width: Math.ceil(maxWidth),
          height: Math.ceil(totalHeight),
          pageHeight: Math.ceil(firstHeight),
        };
      })()`,
    );

    if (contentSize.width > 0 && contentSize.pageHeight > 0) {
      // 窗口只设为单页尺寸，避免多页叠加导致窗口过窄过高而触发打印旋转
      tempPrintWindow.setContentSize(contentSize.width, contentSize.pageHeight);

      // 再等一帧确保 resize 后布局稳定
      await tempPrintWindow.webContents.executeJavaScript(
        `new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        })`,
      );

      // 设置 pageSize 以匹配单页实际尺寸（单位：微米）
      const pxToMicrons = (px) => Math.round((px / 96) * 25400);
      const pageHeight = contentSize.pageHeight || contentSize.height;
      printOptions.pageSize = {
        width: pxToMicrons(contentSize.width),
        height: pxToMicrons(pageHeight),
      };
    }
  } catch (err) {
    console.error(`HTML打印页面加载/渲染失败: ${err.message}`);
    if (!tempPrintWindow.isDestroyed()) {
      tempPrintWindow.destroy();
    }
    return;
  }

  return new Promise((resolve) => {
    tempPrintWindow.webContents.print(
      printOptions,
      (success, failureReason) => {
        if (!success) {
          console.error(
            `HTML打印失败: ${normalizePrintFailureReason(failureReason)}`,
          );
          resolve();
          return;
        }
        if (data.taskId) {
          PRINT_RUNNER_DONE[data.taskId]();
          delete PRINT_RUNNER_DONE[data.taskId];
        }
        if (socket) {
          const result = {
            msg: "打印成功",
            templateId: data.templateId,
            replyId: data.replyId,
          };
          socket.emit("successs", result); // 兼容 vue-plugin-hiprint 0.0.56 之前包
          socket.emit("success", result);
        }
        logPrintResult("success");
        MAIN_WINDOW.webContents.send("printTask", PRINT_RUNNER.isBusy());
        setTimeout(() => resolve(), 180);
      },
    );
  }).finally(() => {
    if (!tempPrintWindow.isDestroyed()) {
      tempPrintWindow.destroy();
    }
  });
}

function oldPdfPrint(data, socket, deviceName, logPrintResult) {
  const pdfPath = path.join(
    store.get("pdfPath") || os.tmpdir(),
    "hiprint",
    dayjs().format(`YYYY_MM_DD HH_mm_ss_`) + `${uuidv7()}.pdf`,
  );
  fs.mkdirSync(path.dirname(pdfPath), {
    recursive: true,
  });
  PRINT_WINDOW.webContents
    .printToPDF({
      landscape: data.landscape ?? false, // 横向打印
      displayHeaderFooter: data.displayHeaderFooter ?? false, // 显示页眉页脚
      printBackground: data.printBackground ?? true, // 打印背景色
      scale: data.scale ?? 1, // 渲染比例 默认 1
      pageSize: data.pageSize,
      margins: data.margins ?? {
        marginType: "none",
      }, // 边距
      pageRanges: data.pageRanges, // 打印页数范围
      headerTemplate: data.headerTemplate, // 页头模板 (html)
      footerTemplate: data.footerTemplate, // 页脚模板 (html)
      preferCSSPageSize: data.preferCSSPageSize ?? false,
    })
    .then((pdfData) => {
      fs.writeFileSync(pdfPath, pdfData);
      printPdf(pdfPath, deviceName, data)
        .then(() => {
          console.log(
            `${data.replyId ? "中转服务" : "插件端"} ${socket.id} 模板 【${
              data.templateId
            }】 打印成功，打印类型：PDF，打印机：${deviceName}，页数：${
              data.pageNum
            }`,
          );
          if (socket) {
            const result = {
              msg: "打印成功",
              templateId: data.templateId,
              replyId: data.replyId,
            };
            socket.emit("successs", result); // 兼容 vue-plugin-hiprint 0.0.56 之前包
            socket.emit("success", result);
          }
          logPrintResult("success");
        })
        .catch((err) => {
          console.log(
            `${data.replyId ? "中转服务" : "插件端"} ${socket.id} 模板 【${
              data.templateId
            }】 打印失败，打印类型：PDF，打印机：${deviceName}，原因：${
              err.message
            }`,
          );
          socket &&
            socket.emit("error", {
              msg: "打印失败: " + err.message,
              templateId: data.templateId,
              replyId: data.replyId,
            });
          logPrintResult("failed", err.message);
        })
        .finally(() => {
          if (data.taskId) {
            // 通过taskMap 调用 task done 回调
            PRINT_RUNNER_DONE[data.taskId]();
            // 删除 task
            delete PRINT_RUNNER_DONE[data.taskId];
          }
          MAIN_WINDOW.webContents.send("printTask", PRINT_RUNNER.isBusy());
        });
    });
}

/**
 * @description: 绑定打印窗口事件
 * @return {Void}
 */
function initPrintEvent() {
  ipcMain.on("do", async (event, data) => {
    let socket = null;
    if (data.clientType === "local") {
      socket = SOCKET_SERVER.sockets.sockets.get(data.socketId);
    } else {
      socket = SOCKET_CLIENT;
    }
    const printers = await PRINT_WINDOW.webContents.getPrintersAsync();
    const {
      printerName: defaultPrinter,
      printerInfo: currentPrinter,
      exists: havePrinter,
    } = resolveTargetPrinter(printers, data.printer || store.get("defaultPrinter", ""));
    if (!havePrinter) {
      console.log(
        `${data.replyId ? "中转服务" : "插件端"} ${socket.id} 模板 【${data.templateId
        }】 打印失败，打印机不存在，打印机：${defaultPrinter || data.printer || "未指定"}`,
      );
      socket &&
        socket.emit("error", {
          msg: `${defaultPrinter || data.printer || "指定"}打印机不存在`,
          templateId: data.templateId,
          replyId: data.replyId,
        });
      if (data.taskId) {
        // 通过 taskMap 调用 task done 回调
        PRINT_RUNNER_DONE[data.taskId]();
        delete PRINT_RUNNER_DONE[data.taskId];
      }
      MAIN_WINDOW.webContents.send("printTask", PRINT_RUNNER.isBusy());
      return;
    }
    if (typeof currentPrinter.status !== "undefined") {
      console.log(`打印机状态(${defaultPrinter}): ${currentPrinter.status}`);
    }
    const offlineReason = getPrinterOfflineReason(currentPrinter);
    if (offlineReason) {
      console.log(
        `${data.replyId ? "中转服务" : "插件端"} ${socket?.id} 模板 【${data.templateId
        }】 打印失败，打印机离线，打印机：${defaultPrinter}，${offlineReason}`,
      );
      socket &&
        socket.emit("error", {
          msg: "打印机不在线",
          templateId: data.templateId,
          replyId: data.replyId,
        });
      if (data.taskId) {
        PRINT_RUNNER_DONE[data.taskId]();
        delete PRINT_RUNNER_DONE[data.taskId];
      }
      MAIN_WINDOW.webContents.send("printTask", PRINT_RUNNER.isBusy());
      return;
    }
    let deviceName = defaultPrinter;

    const logPrintResult = (status, errorMessage = "") => {
      db.run(
        `INSERT INTO print_logs (socketId, clientType, printer, templateId, data, pageNum, status, rePrintAble, errorMessage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          socket?.id,
          data.clientType,
          deviceName,
          data.templateId,
          JSON.stringify(data),
          data.pageNum,
          status,
          data.rePrintAble ?? 1,
          errorMessage,
        ],
        (err) => {
          if (err) {
            console.error("Failed to log print result", err);
          }
        },
      );
    };

    // pdf 打印
    let isPdf = data.type && `${data.type}`.toLowerCase() === "pdf";
    if (isPdf) {
      printHTMLByData(data, socket, logPrintResult, defaultPrinter)
      return
    }
    // url_pdf 打印
    const isUrlPdf = data.type && `${data.type}`.toLowerCase() === "url_pdf";
    if (isUrlPdf) {
      printPdf(data.pdf_path, deviceName, data)
        .then(() => {
          console.log(
            `${data.replyId ? "中转服务" : "插件端"} ${socket.id} 模板 【${data.templateId
            }】 打印成功，打印类型：URL_PDF，打印机：${deviceName}，页数：${data.pageNum
            }`,
          );
          if (socket) {
            checkPrinterStatus(deviceName, () => {
              const result = {
                msg: "打印成功",
                templateId: data.templateId,
                replyId: data.replyId,
              };
              socket.emit("successs", result); // 兼容 vue-plugin-hiprint 0.0.56 之前包
              socket.emit("success", result);
            });
          }
          logPrintResult("success");
        })
        .catch((err) => {
          console.log(
            `${data.replyId ? "中转服务" : "插件端"} ${socket.id} 模板 【${data.templateId
            }】 打印失败，打印类型：URL_PDF，打印机：${deviceName}，原因：${err.message
            }`,
          );
          socket &&
            socket.emit("error", {
              msg: "打印失败: " + err.message,
              templateId: data.templateId,
              replyId: data.replyId,
            });
          logPrintResult("failed", err.message);
        })
        .finally(() => {
          if (data.taskId) {
            // 通过 taskMap 调用 task done 回调
            PRINT_RUNNER_DONE[data.taskId]();
            // 删除 task
            delete PRINT_RUNNER_DONE[data.taskId];
          }
          MAIN_WINDOW.webContents.send("printTask", PRINT_RUNNER.isBusy());
        });
      return;
    }

    // blob_pdf 打印 - 直接接收二进制PDF数据
    const isBlobPdf = data.type && `${data.type}`.toLowerCase() === "blob_pdf";
    if (isBlobPdf) {
      // 验证必要参数
      if (!data.pdf_blob) {
        const errorMsg = "blob_pdf类型打印缺少pdf_blob参数";
        console.log(
          `${data.replyId ? "中转服务" : "插件端"} ${socket?.id} 模板 【${data.templateId
          }】 打印失败，原因：${errorMsg}`,
        );
        socket &&
          socket.emit("error", {
            msg: errorMsg,
            templateId: data.templateId,
            replyId: data.replyId,
          });
        logPrintResult("failed", errorMsg);
        if (data.taskId) {
          PRINT_RUNNER_DONE[data.taskId]();
          delete PRINT_RUNNER_DONE[data.taskId];
        }
        MAIN_WINDOW.webContents.send("printTask", PRINT_RUNNER.isBusy());
        return;
      }
      let pdfBlob = data.pdf_blob;
      delete data.pdf_blob;
      printPdfBlob(pdfBlob, deviceName, data)
        .then(() => {
          console.log(
            `${data.replyId ? "中转服务" : "插件端"} ${socket.id} 模板 【${data.templateId
            }】 打印成功，打印类型：BLOB_PDF，打印机：${deviceName}，页数：${data.pageNum
            }`,
          );
          if (socket) {
            checkPrinterStatus(deviceName, () => {
              const result = {
                msg: "打印成功",
                templateId: data.templateId,
                replyId: data.replyId,
              };
              socket.emit("successs", result); // 兼容 vue-plugin-hiprint 0.0.56 之前包
              socket.emit("success", result);
            });
          }
          logPrintResult("success");
        })
        .catch((err) => {
          console.log(
            `${data.replyId ? "中转服务" : "插件端"} ${socket.id} 模板 【${data.templateId
            }】 打印失败，打印类型：BLOB_PDF，打印机：${deviceName}，原因：${err.message
            }`,
          );
          socket &&
            socket.emit("error", {
              msg: "打印失败: " + err.message,
              templateId: data.templateId,
              replyId: data.replyId,
            });
          logPrintResult("failed", err.message);
        })
        .finally(() => {
          if (data.taskId) {
            // 通过 taskMap 调用 task done 回调
            PRINT_RUNNER_DONE[data.taskId]();
            // 删除 task
            delete PRINT_RUNNER_DONE[data.taskId];
          }
          MAIN_WINDOW.webContents.send("printTask", PRINT_RUNNER.isBusy());
        });
      return;
    }
    // 打印 详见https://www.electronjs.org/zh/docs/latest/api/web-contents
    PRINT_WINDOW.webContents.print(
      {
        silent: data.silent ?? true, // 静默打印
        printBackground: data.printBackground ?? true, // 是否打印背景
        deviceName: deviceName, // 打印机名称
        color: data.color ?? true, // 是否打印颜色
        margins: data.margins ?? {
          marginType: "none",
        }, // 边距
        landscape: data.landscape ?? false, // 是否横向打印
        scaleFactor: data.scaleFactor ?? 100, // 打印缩放比例
        pagesPerSheet: data.pagesPerSheet ?? 1, // 每张纸的页数
        collate: data.collate ?? true, // 是否排序
        copies: data.copies ?? 1, // 打印份数
        pageRanges: data.pageRanges ?? {}, // 打印页数
        duplexMode: data.duplexMode, // 打印模式 simplex,shortEdge,longEdge
        dpi: data.dpi ?? 300, // 打印机DPI
        header: data.header, // 打印头
        footer: data.footer, // 打印尾
        pageSize: data.pageSize, // 打印纸张
      },
      (success, failureReason) => {
        const normalizedFailureReason = normalizePrintFailureReason(failureReason);
        if (success) {
          console.log(
            `${data.replyId ? "中转服务" : "插件端"} ${socket?.id} 模板 【${data.templateId
            }】 打印成功，打印类型 HTML，打印机：${deviceName}，页数：${data.pageNum
            }`,
          );
          logPrintResult("success");
        } else {
          console.log(
            `${data.replyId ? "中转服务" : "插件端"} ${socket?.id} 模板 【${data.templateId
            }】 打印失败，打印类型 HTML，打印机：${deviceName}，原因：${normalizedFailureReason}`,
          );
          logPrintResult("failed", normalizedFailureReason);
        }
        if (socket) {
          if (success) {
            const result = {
              msg: "打印成功",
              templateId: data.templateId,
              replyId: data.replyId,
            };
            socket.emit("successs", result); // 兼容 vue-plugin-hiprint 0.0.56 之前包
            socket.emit("success", result);
          } else {
            socket.emit("error", {
              msg: normalizedFailureReason,
              templateId: data.templateId,
              replyId: data.replyId,
            });
          }
        }
        // 通过 taskMap 调用 task done 回调
        if (data.taskId) {
          PRINT_RUNNER_DONE[data.taskId]();
          // 删除 task
          delete PRINT_RUNNER_DONE[data.taskId];
        }
        MAIN_WINDOW.webContents.send("printTask", PRINT_RUNNER.isBusy());
      },
    );
  });

  ipcMain.on("printPDF", async (event, data) => {

    let socket = null;
    if (data.clientType === "local") {
      socket = SOCKET_SERVER.sockets.sockets.get(data.socketId);
    } else {
      socket = SOCKET_CLIENT;
    }
    const printers = await PRINT_WINDOW.webContents.getPrintersAsync();
    const {
      printerName: defaultPrinter,
      printerInfo: currentPrinter,
      exists: havePrinter,
    } = resolveTargetPrinter(printers, data.printer || store.get("defaultPrinter", ""));
    if (!havePrinter) {
      console.log(
        `${data.replyId ? "中转服务" : "插件端"} ${socket.id} 模板 【${data.templateId
        }】 打印失败，打印机不存在，打印机：${defaultPrinter || data.printer || "未指定"}`,
      );
      socket &&
        socket.emit("error", {
          msg: `${defaultPrinter || data.printer || "指定"}打印机不存在`,
          templateId: data.templateId,
          replyId: data.replyId,
        });
      if (data.taskId) {
        // 通过 taskMap 调用 task done 回调
        PRINT_RUNNER_DONE[data.taskId]();
        delete PRINT_RUNNER_DONE[data.taskId];
      }
      MAIN_WINDOW.webContents.send("printTask", PRINT_RUNNER.isBusy());
      return;
    }
    if (typeof currentPrinter.status !== "undefined") {
      console.log(`打印机状态(${defaultPrinter}): ${currentPrinter.status}`);
    }
    const offlineReason = getPrinterOfflineReason(currentPrinter);
    if (offlineReason) {
      console.log(
        `${data.replyId ? "中转服务" : "插件端"} ${socket?.id} 模板 【${data.templateId
        }】 打印失败，打印机离线，打印机：${defaultPrinter}，${offlineReason}`,
      );
      socket &&
        socket.emit("error", {
          msg: "打印机不在线",
          templateId: data.templateId,
          replyId: data.replyId,
        });
      if (data.taskId) {
        PRINT_RUNNER_DONE[data.taskId]();
        delete PRINT_RUNNER_DONE[data.taskId];
      }
      MAIN_WINDOW.webContents.send("printTask", PRINT_RUNNER.isBusy());
      return;
    }
    let deviceName = defaultPrinter;

    const {
      unit,
      width: pdfWidth,
      height: pdfHeight,
      base64: base64Image,
    } = data;

    // 3. 计算图片在 PDF 中的尺寸（可选：铺满 PDF 或自定义大小）
    // 方案 A：图片铺满整个 PDF 页面（保持比例，避免拉伸）
    // 先获取图片原始尺寸（通过 Image 对象加载）
    const { width: imgWidth, height: imgHeight } = getBase64ImageDimensions(base64Image)

    // 计算图片在 PDF 中的缩放比例（确保宽高不超过 PDF 尺寸）
    const scaleX = pdfWidth / (imgWidth / 37.8); // 转换图片像素到 PDF 单位（1cm ≈ 37.8 像素）
    const scaleY = pdfHeight / (imgHeight / 37.8);
    const scale = Math.min(scaleX, scaleY); // 取最小缩放比例，避免超出页面

    // 计算缩放后的图片尺寸
    const scaledWidth = (imgWidth / 37.8) * scale;
    const scaledHeight = (imgHeight / 37.8) * scale;

    // 计算居中位置（可选：如需居中显示）
    const x = (pdfWidth - scaledWidth) / 2;
    const y = (pdfHeight - scaledHeight) / 2;

    // 为避免jsPDF宽高对调bug，强制指定orientation
    let orientation = "portrait";
    if (pdfWidth > pdfHeight) {
      orientation = "landscape";
    }

    // 创建PDF并指定匡高，此时指定的unit会贯穿后续操作
    const pdf = new jspdf({
      unit: unit, // 设置单位
      orientation,
      format: [pdfWidth, pdfHeight], // 设置 PDF 宽高
    });

    // 4. 将图片添加到 PDF 中
    pdf.addImage(
      base64Image, // Base64 图片内容
      "JPEG", // 图片格式
      0,  // 图片左上角 X 坐标
      0, // 图片左上角 Y 坐标
      pdfWidth, // 图片宽度,目前等于指定模版宽度，不应拉伸，否则会模糊
      pdfHeight, // 图片高度,目前等于指定模版高度，不应拉伸，否则会模糊
    );

    // 生成Buffer
    const pdfArrayBuffer = pdf.output('arraybuffer');
    const pdfBuffer = Buffer.from(pdfArrayBuffer);

    // 保存到特定路径
    const savePath = path.join(store.get("pdfPath") || os.tmpdir(), "temp.pdf");
    fs.writeFileSync(savePath, pdfBuffer);

    const onFinally = () => {
      if (data.taskId) {
        // 通过taskMap 调用 task done 回调
        PRINT_RUNNER_DONE[data.taskId]();
        // 删除 task
        delete PRINT_RUNNER_DONE[data.taskId];
      }
      MAIN_WINDOW.webContents.send("printTask", PRINT_RUNNER.isBusy());
    }

    const onSuccess = () => {
      if (socket) {
        const result = {
          msg: "打印成功",
          templateId: data.templateId,
          replyId: data.replyId,
        };
        socket.emit("success", result);
      }
      onFinally()
    }

    const onFail = (err) => {
      const normalizedFailureReason = normalizePrintFailureReason(err?.message);
      socket &&
        socket.emit("error", {
          msg: normalizedFailureReason,
          templateId: data.templateId,
          replyId: data.replyId,
        });
      onFinally()
    }

    const printOptions = {
      orientation,
      printer: defaultPrinter,
      scale: 'fit',
    }

    realPrint(savePath, deviceName, printOptions, onSuccess, onFail)
  });

  ipcMain.on("printPDFBatch", async (event, data) => {

    let socket = null;
    if (data.clientType === "local") {
      socket = SOCKET_SERVER.sockets.sockets.get(data.socketId);
    } else {
      socket = SOCKET_CLIENT;
    }
    const printers = await PRINT_WINDOW.webContents.getPrintersAsync();
    const {
      printerName: defaultPrinter,
      printerInfo: currentPrinter,
      exists: havePrinter,
    } = resolveTargetPrinter(printers, data.printer || store.get("defaultPrinter", ""));
    if (!havePrinter) {
      console.log(
        `${data.replyId ? "中转服务" : "插件端"} ${socket.id} 模板 【${data.templateId
        }】 打印失败，打印机不存在，打印机：${defaultPrinter || data.printer || "未指定"}`,
      );
      socket &&
        socket.emit("error", {
          msg: `${defaultPrinter || data.printer || "指定"}打印机不存在`,
          templateId: data.templateId,
          replyId: data.replyId,
        });
      if (data.taskId) {
        // 通过 taskMap 调用 task done 回调
        PRINT_RUNNER_DONE[data.taskId]();
        delete PRINT_RUNNER_DONE[data.taskId];
      }
      MAIN_WINDOW.webContents.send("printTask", PRINT_RUNNER.isBusy());
      return;
    }
    if (typeof currentPrinter.status !== "undefined") {
      console.log(`打印机状态(${defaultPrinter}): ${currentPrinter.status}`);
    }
    const offlineReason = getPrinterOfflineReason(currentPrinter);
    if (offlineReason) {
      console.log(
        `${data.replyId ? "中转服务" : "插件端"} ${socket?.id} 模板 【${data.templateId
        }】 打印失败，打印机离线，打印机：${defaultPrinter}，${offlineReason}`,
      );
      socket &&
        socket.emit("error", {
          msg: "打印机不在线",
          templateId: data.templateId,
          replyId: data.replyId,
        });
      if (data.taskId) {
        PRINT_RUNNER_DONE[data.taskId]();
        delete PRINT_RUNNER_DONE[data.taskId];
      }
      MAIN_WINDOW.webContents.send("printTask", PRINT_RUNNER.isBusy());
      return;
    }
    let deviceName = defaultPrinter;

    const {
      unit = "mm",
      width: tagWidth, // 标签大小，单位mm，每个标签都一样
      height: tagHeight, // 标签大小，单位mm，每个标签都一样
      horizontalMargin = 0, // 标签水平间距，单位mm，第一列和最后一列没有间距
      verticalMargin = 0, // 标签垂直间距，单位mm，第一行和最后一行没有间距
      boxMargin = 0, // 纸张四周间距，单位mm
      base64List, // 图片 Base64 列表
      col = 1, // 标签列数，默认1列
      paperWidth, // 纸张宽度 (可选)
      paperHeight, // 纸张高度 (可选)
    } = data;

    // 3. 计算 PDF 尺寸
    // 如果没有提供纸张大小，则根据标签和边距计算最小所需大小
    const calculatedWidth = boxMargin * 2 + col * tagWidth + (col - 1) * horizontalMargin;
    // 默认高度：如果未指定，默认一页只打印一行（适合卷纸）或根据内容动态调整
    const calculatedHeight = boxMargin * 2 + tagHeight;

    const pdfWidth = paperWidth || calculatedWidth;
    const pdfHeight = paperHeight || calculatedHeight;

    // 为避免jsPDF宽高对调bug，强制指定orientation
    let orientation = "portrait";
    if (pdfWidth > pdfHeight) {
      orientation = "landscape";
    }

    // 创建PDF并指定宽高，此时指定的unit会贯穿后续操作
    const pdf = new jspdf({
      unit: unit, // 设置单位
      orientation,
      format: [pdfWidth, pdfHeight], // 设置 PDF 宽高
    });

    // 4. 将图片添加到 PDF 中
    const images = Array.isArray(base64List) ? base64List : (base64List ? [base64List] : []);

    let currentX = boxMargin;
    let currentY = boxMargin;
    let columnIndex = 0;

    images.forEach((img) => {
      // 换行判断
      if (columnIndex >= col) {
        columnIndex = 0;
        currentX = boxMargin;
        currentY += tagHeight + verticalMargin;
      }

      // 换页判断
      // 如果当前行的高度超出了页面高度（减去下边距）
      if (currentY + tagHeight > pdfHeight - boxMargin + 0.01) {
        pdf.addPage([pdfWidth, pdfHeight], orientation);
        currentX = boxMargin;
        currentY = boxMargin;
        columnIndex = 0;
      }

      pdf.addImage(
        img,
        "JPEG",
        currentX,
        currentY,
        tagWidth,
        tagHeight
      );

      // 移动 X 坐标
      currentX += tagWidth + horizontalMargin;
      columnIndex++;
    });

    // 生成Buffer
    const pdfArrayBuffer = pdf.output('arraybuffer');
    const pdfBuffer = Buffer.from(pdfArrayBuffer);

    const onFinally = () => {
      if (data.taskId) {
        // 通过taskMap 调用 task done 回调
        PRINT_RUNNER_DONE[data.taskId]();
        // 删除 task
        delete PRINT_RUNNER_DONE[data.taskId];
      }
      MAIN_WINDOW.webContents.send("printTask", PRINT_RUNNER.isBusy());
    }

    const onSuccess = () => {
      if (socket) {
        const result = {
          msg: "打印成功",
          templateId: data.templateId,
          replyId: data.replyId,
        };
        socket.emit("success", result);
      }
      onFinally()
    }

    const onFail = (err) => {
      const normalizedFailureReason = normalizePrintFailureReason(err?.message);
      socket &&
        socket.emit("error", {
          msg: normalizedFailureReason,
          templateId: data.templateId,
          replyId: data.replyId,
        });
      onFinally()
    }

    // 保存到特定路径
    const savePath = path.join(store.get("pdfPath") || os.tmpdir(), "temp.pdf");
    try {
      fs.writeFileSync(savePath, pdfBuffer);

      const printOptions = {
        orientation,
        printer: defaultPrinter,
        scale: 'fit',
      }

      realPrint(savePath, deviceName, printOptions, onSuccess, onFail)
    } catch (error) {
      onFail({ message: '文件写入失败' })
    }
  });

  ipcMain.on("printSVGBatch", async (event, data) => {
    let socket = null;
    if (data.clientType === "local") {
      socket = SOCKET_SERVER.sockets.sockets.get(data.socketId);
    } else {
      socket = SOCKET_CLIENT;
    }

    const onFinally = () => {
      if (data.taskId) {
        PRINT_RUNNER_DONE[data.taskId]();
        delete PRINT_RUNNER_DONE[data.taskId];
      }
      MAIN_WINDOW.webContents.send("printTask", PRINT_RUNNER.isBusy());
    };

    const onFail = (err) => {
      socket &&
        socket.emit("error", {
          msg: "打印失败: " + err.message,
          templateId: data.templateId,
          replyId: data.replyId,
        });
      onFinally();
    };

    const onSuccess = () => {
      if (socket) {
        socket.emit("success", {
          msg: "打印成功",
          templateId: data.templateId,
          replyId: data.replyId,
        });
      }
      onFinally();
    };

    const printers = await PRINT_WINDOW.webContents.getPrintersAsync();
    const {
      printerName: defaultPrinter,
      printerInfo: currentPrinter,
      exists: havePrinter,
    } = resolveTargetPrinter(printers, data.printer || store.get("defaultPrinter", ""));
    if (!havePrinter) {
      console.log(
        `${data.replyId ? "中转服务" : "插件端"} ${socket?.id} 模板 【${data.templateId
        }】 打印失败，打印机不存在，打印机：${defaultPrinter || data.printer || "未指定"}`,
      );
      socket &&
        socket.emit("error", {
          msg: `${defaultPrinter || data.printer || "指定"}打印机不存在`,
          templateId: data.templateId,
          replyId: data.replyId,
        });
      onFinally();
      return;
    }
    if (typeof currentPrinter.status !== "undefined") {
      console.log(`打印机状态(${defaultPrinter}): ${currentPrinter.status}`);
    }
    const offlineReason = getPrinterOfflineReason(currentPrinter);
    if (offlineReason) {
      console.log(
        `${data.replyId ? "中转服务" : "插件端"} ${socket?.id} 模板 【${data.templateId
        }】 打印失败，打印机离线，打印机：${defaultPrinter}，${offlineReason}`,
      );
      socket &&
        socket.emit("error", {
          msg: "打印机不在线",
          templateId: data.templateId,
          replyId: data.replyId,
        });
      onFinally();
      return;
    }

    try {
      const svgList = Array.isArray(data.svgList) ? data.svgList : [];
      if (!svgList.length) {
        throw new Error("svgList 不能为空");
      }

      const svgPages = svgList.map((item, index) => {
        const raw = typeof item === "string" ? item : "";
        let svgContent = raw;
        try {
          svgContent = JSON.parse(raw);
        } catch (_) {
          // 兼容已是原始 SVG 字符串的情况
        }
        if (typeof svgContent !== "string") {
          throw new Error(`第 ${index + 1} 个 SVG 解析失败`);
        }
        const trimmedSvg = svgContent.trim();
        const svgStart = trimmedSvg.toLowerCase().indexOf("<svg");
        const svgEnd = trimmedSvg.toLowerCase().lastIndexOf("</svg>");
        if (svgStart < 0 || svgEnd < 0 || svgEnd < svgStart) {
          throw new Error(`第 ${index + 1} 个 SVG 内容无效`);
        }
        const normalizedSvg = trimmedSvg.slice(svgStart, svgEnd + "</svg>".length);
        if (!normalizedSvg.toLowerCase().startsWith("<svg")) {
          throw new Error(`第 ${index + 1} 个 SVG 内容无效`);
        }
        return `<div class="svg-page">${normalizedSvg}</div>`;
      });

      const svgBatchStylePath = path.join(
        app.getAppPath(),
        "assets",
        "css",
        "svg-batch-print.css",
      );
      const styleContent = fs.readFileSync(svgBatchStylePath, "utf8");

      const tempHtmlDir = store.get("pdfPath") || os.tmpdir();
      fs.mkdirSync(tempHtmlDir, { recursive: true });

      const tempHtmlPath = path.join(
        tempHtmlDir,
        "temp-svg-print.html",
      );
      const requestUnit = normalizePrintUnit(data.unit || "mm");
      const requestWidth = Number(data.width) || 0;
      const requestHeight = Number(data.height) || 0;
      const hasRequestedSize = requestWidth > 0 && requestHeight > 0;
      const dynamicStyle = hasRequestedSize
        ? `
@page { size: ${requestWidth}${requestUnit} ${requestHeight}${requestUnit}; margin: 0; }
.svg-page { width: ${requestWidth}${requestUnit}; height: ${requestHeight}${requestUnit}; display: block; box-sizing: border-box; overflow: hidden; page-break-inside: avoid; break-inside: avoid-page; }
.svg-page svg { display: block; width: 100%; height: 100%; }
`
        : "";
      const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>${data.title ? data.title : "SVG批量打印"}</title>
  <style>${styleContent}
${dynamicStyle}</style>
</head>
<body>
  <div id="printElement">${svgPages.join("")}</div>
</body>
</html>`;
      fs.writeFileSync(tempHtmlPath, htmlContent, "utf8");
      console.log(`[printSVGBatch] 临时Html文件: ${tempHtmlPath}`);

      const pageRanges =
        typeof data.pageRanges === "string" ? data.pageRanges : undefined;
      const printOptions = {
        silent: data.silent ?? true,
        printBackground: data.printBackground ?? true,
        deviceName: defaultPrinter,
        color: data.color ?? true,
        margins: data.margins ?? {
          marginType: "none",
        },
        landscape: data.landscape ?? false,
        scaleFactor: data.scaleFactor ?? 100,
        pagesPerSheet: data.pagesPerSheet ?? 1,
        collate: data.collate ?? true,
        copies: data.copies ?? 1,
        pageRanges,
        duplexMode: data.duplexMode,
        dpi: data.dpi ?? 300,
        pageSize: data.pageSize,
      };
      if (hasRequestedSize) {
        printOptions.pageSize = {
          width: convertUnitToMicrons(requestWidth, requestUnit),
          height: convertUnitToMicrons(requestHeight, requestUnit),
        };
      }

      const printBatchHtml = (batchHtmlPath, totalPages) => new Promise((resolve, reject) => {
        const tempPrintWindow = new BrowserWindow({
          width: 100,
          height: 100,
          show: false,
          webPreferences: {
            contextIsolation: false,
            nodeIntegration: true,
          },
          backgroundColor: "#fff",
        });

        let settled = false;
        const done = (err) => {
          if (settled) return;
          settled = true;
          if (!tempPrintWindow.isDestroyed()) {
            tempPrintWindow.destroy();
          }
          if (err) {
            reject(err);
            return;
          }
          resolve();
        };

        tempPrintWindow.webContents.once("did-fail-load", (_event, errorCode, errorDescription) => {
          done(new Error(`SVG批量临时HTML加载失败(${errorCode}): ${errorDescription}`));
        });

        tempPrintWindow
          .loadURL(pathToFileURL(batchHtmlPath).href)
          .then(() => {
            setTimeout(() => {
              tempPrintWindow.webContents
                .executeJavaScript(`new Promise((resolve) => {
                  requestAnimationFrame(() => requestAnimationFrame(resolve));
                })`)
                .then(() =>
                  tempPrintWindow.webContents.executeJavaScript(`(() => {
                    const pages = Array.from(document.querySelectorAll(".svg-page"));
                    if (!pages.length) {
                      return { hasSvg: false, width: 0, height: 0 };
                    }
                    const reqWidth = ${JSON.stringify(requestWidth)};
                    const reqHeight = ${JSON.stringify(requestHeight)};
                    const reqUnit = ${JSON.stringify(requestUnit)};
                    const hasRequestedSize = reqWidth > 0 && reqHeight > 0;
                    let maxWidth = 0;
                    let totalHeight = 0;
                    let hasSvg = false;
                    pages.forEach((page) => {
                      const svg = page.querySelector("svg");
                      if (!svg) return;
                      hasSvg = true;
                      const viewBox = svg.viewBox && svg.viewBox.baseVal
                        ? svg.viewBox.baseVal
                        : null;
                      const rect = svg.getBoundingClientRect();
                      let width = rect.width;
                      let height = rect.height;
                      if (!(width > 0 && height > 0) && viewBox && viewBox.width > 0 && viewBox.height > 0) {
                        width = viewBox.width;
                        height = viewBox.height;
                      }
                      if (hasRequestedSize) {
                        page.style.width = reqWidth + reqUnit;
                        page.style.height = reqHeight + reqUnit;
                        svg.style.width = "100%";
                        svg.style.height = "100%";
                      }
                      if (width > 0 && height > 0) {
                        if (!hasRequestedSize) {
                          svg.style.width = width + "px";
                          svg.style.height = height + "px";
                          page.style.width = width + "px";
                          page.style.height = height + "px";
                        }
                        maxWidth = Math.max(maxWidth, width);
                        totalHeight += height;
                      }
                    });
                    const printElement = document.querySelector("#printElement");
                    if (printElement && maxWidth > 0 && totalHeight > 0) {
                      printElement.style.width = maxWidth + "px";
                      printElement.style.height = totalHeight + "px";
                    }
                    if (hasRequestedSize) {
                      return { hasSvg, width: reqWidth, height: reqHeight, unit: reqUnit };
                    }
                    return { hasSvg, width: maxWidth, height: totalHeight, unit: "px" };
                  })()`),
                )
                .then((svgInfo) => {
                  if (!svgInfo?.hasSvg) {
                    done(
                      new Error(
                        `SVG批量打印不存在可打印SVG节点`,
                      ),
                    );
                    return;
                  }
                  if (!(svgInfo.width > 0 && svgInfo.height > 0)) {
                    done(
                      new Error(
                        `SVG批量打印尺寸异常(${svgInfo.width}x${svgInfo.height})`,
                      ),
                    );
                    return;
                  }
                  if (hasRequestedSize) {
                    tempPrintWindow.setContentSize(
                      convertUnitToPx(svgInfo.width, svgInfo.unit),
                      convertUnitToPx(svgInfo.height, svgInfo.unit),
                    );
                  } else {
                    tempPrintWindow.setContentSize(
                      Math.ceil(svgInfo.width),
                      Math.ceil(svgInfo.height),
                    );
                  }
                  tempPrintWindow.webContents.print(printOptions, (success, failureReason) => {
                    if (!success) {
                      done(
                        new Error(
                          `SVG批量打印失败: ${normalizePrintFailureReason(failureReason)}`,
                        ),
                      );
                      return;
                    }
                    // 部分驱动在回调后立即销毁窗口会出现空白页，这里给极短缓冲
                    setTimeout(() => done(), 180);
                  });
                })
                .catch((err) => {
                  done(
                    new Error(
                      `SVG批量渲染失败: ${err.message}`,
                    ),
                  );
                });
            }, data.svgRenderDelayMs ?? 120);
          })
          .catch((err) => {
            done(new Error(`SVG批量加载异常: ${err.message}`));
          });
      });

      await printBatchHtml(tempHtmlPath, svgPages.length);

      onSuccess();
    } catch (error) {
      onFail({ message: error.message || "SVG 批量打印失败" });
    }
  });
}

function checkPrinterStatus(deviceName, callback) {
  const intervalId = setInterval(() => {
    PRINT_WINDOW.webContents
      .getPrintersAsync()
      .then((printers) => {
        const printer = printers.find((printer) => printer.name === deviceName);
        console.log(`current printer: ${JSON.stringify(printer)}`);
        const ISCAN_STATUS = process.platform === "win32" ? 0 : 3;
        if (printer && printer.status === ISCAN_STATUS) {
          callback && callback();
          clearInterval(intervalId); // Stop polling when status is 0
          console.log(
            `Printer ${deviceName} is now ready (status: ${ISCAN_STATUS})`,
          );
          // You can add any additional logic here for when the printer is ready
        }
      })
      .catch((error) => {
        clearInterval(intervalId); // Also clear interval on error
        console.log(`Error checking printer status: ${error}`);
      });
  }, 1000); // Check every 1 second (adjust interval as needed)

  return intervalId; // Return the interval ID in case you need to cancel it externally
}

module.exports = async () => {
  // 创建打印窗口
  await createPrintWindow();
};

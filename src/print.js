"use strict";

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { printPdf, printPdfBlob, realPrint } = require("./pdf-print");
const { store, getCurrentPrintStatusByName } = require("../tools/utils");
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
  let printHtml = path.join("file://", app.getAppPath(), "/assets/print.html");
  PRINT_WINDOW.webContents.loadURL(printHtml);

  // 未打包时打开开发者工具
  // if (!app.isPackaged) {
  //   PRINT_WINDOW.webContents.openDevTools();
  // }

  // 绑定窗口事件
  initPrintEvent();

  return PRINT_WINDOW;
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
    let havePrinter = false;
    let defaultPrinter = data.printer || store.get("defaultPrinter", "");
    let printerError = false;
    printers.forEach((element) => {
      // 获取默认打印机
      if (
        element.isDefault &&
        (defaultPrinter == "" || defaultPrinter == void 0)
      ) {
        defaultPrinter = element.name;
      }
      // 判断打印机是否存在
      if (element.name === defaultPrinter) {
        // todo: 打印机状态对照表
        // win32: https://learn.microsoft.com/en-us/windows/win32/printdocs/printer-info-2
        // cups: https://www.cups.org/doc/cupspm.html#ipp_status_e
        if (process.platform === "win32") {
          if (element.status != 0) {
            printerError = true;
          }
        } else {
          if (element.status != 3) {
            printerError = true;
          }
        }
        havePrinter = true;
      }
    });
    if (printerError) {
      const { StatusMsg } = getCurrentPrintStatusByName(defaultPrinter);
      console.log(
        `${data.replyId ? "中转服务" : "插件端"} ${socket.id} 模板 【${data.templateId
        }】 打印失败，打印机异常，打印机：${defaultPrinter}, 打印机状态：${StatusMsg}`,
      );
      socket &&
        socket.emit("error", {
          msg: data.printer + "打印机异常",
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
                `${data.replyId ? "中转服务" : "插件端"} ${socket.id} 模板 【${data.templateId
                }】 打印成功，打印类型：PDF，打印机：${deviceName}，页数：${data.pageNum
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
                `${data.replyId ? "中转服务" : "插件端"} ${socket.id} 模板 【${data.templateId
                }】 打印失败，打印类型：PDF，打印机：${deviceName}，原因：${err.message
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
      return;
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
            }】 打印失败，打印类型 HTML，打印机：${deviceName}，原因：${failureReason}`,
          );
          logPrintResult("failed", failureReason);
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
              msg: failureReason,
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
    let havePrinter = false;
    let defaultPrinter = data.printer || store.get("defaultPrinter", "");
    let printerError = false;
    printers.forEach((element) => {
      // 获取默认打印机
      if (
        element.isDefault &&
        (defaultPrinter == "" || defaultPrinter == void 0)
      ) {
        defaultPrinter = element.name;
      }
      // 判断打印机是否存在
      if (element.name === defaultPrinter) {
        // todo: 打印机状态对照表
        // win32: https://learn.microsoft.com/en-us/windows/win32/printdocs/printer-info-2
        // cups: https://www.cups.org/doc/cupspm.html#ipp_status_e
        if (process.platform === "win32") {
          if (element.status != 0) {
            printerError = true;
          }
        } else {
          if (element.status != 3) {
            printerError = true;
          }
        }
        havePrinter = true;
      }
    });
    if (printerError) {
      const { StatusMsg } = getCurrentPrintStatusByName(defaultPrinter);
      console.log(
        `${data.replyId ? "中转服务" : "插件端"} ${socket.id} 模板 【${data.templateId
        }】 打印失败，打印机异常，打印机：${defaultPrinter}, 打印机状态：${StatusMsg}`,
      );
      socket &&
        socket.emit("error", {
          msg: data.printer + "打印机异常",
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
      socket &&
        socket.emit("error", {
          msg: "打印失败: " + err.message,
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
    let havePrinter = false;
    let defaultPrinter = data.printer || store.get("defaultPrinter", "");
    let printerError = false;
    printers.forEach((element) => {
      // 获取默认打印机
      if (
        element.isDefault &&
        (defaultPrinter == "" || defaultPrinter == void 0)
      ) {
        defaultPrinter = element.name;
      }
      // 判断打印机是否存在
      if (element.name === defaultPrinter) {
        // todo: 打印机状态对照表
        // win32: https://learn.microsoft.com/en-us/windows/win32/printdocs/printer-info-2
        // cups: https://www.cups.org/doc/cupspm.html#ipp_status_e
        if (process.platform === "win32") {
          if (element.status != 0) {
            printerError = true;
          }
        } else {
          if (element.status != 3) {
            printerError = true;
          }
        }
        havePrinter = true;
      }
    });
    if (printerError) {
      const { StatusMsg } = getCurrentPrintStatusByName(defaultPrinter);
      console.log(
        `${data.replyId ? "中转服务" : "插件端"} ${socket.id} 模板 【${data.templateId
        }】 打印失败，打印机异常，打印机：${defaultPrinter}, 打印机状态：${StatusMsg}`,
      );
      socket &&
        socket.emit("error", {
          msg: data.printer + "打印机异常",
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
      socket &&
        socket.emit("error", {
          msg: "打印失败: " + err.message,
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
    let defaultPrinter = data.printer || store.get("defaultPrinter", "");
    let printerError = false;
    printers.forEach((element) => {
      if (
        element.isDefault &&
        (defaultPrinter == "" || defaultPrinter == void 0)
      ) {
        defaultPrinter = element.name;
      }
      if (element.name === defaultPrinter) {
        if (process.platform === "win32") {
          if (element.status != 0) {
            printerError = true;
          }
        } else {
          if (element.status != 3) {
            printerError = true;
          }
        }
      }
    });

    if (printerError) {
      const { StatusMsg } = getCurrentPrintStatusByName(defaultPrinter);
      console.log(
        `${data.replyId ? "中转服务" : "插件端"} ${socket?.id} 模板 【${data.templateId
        }】 打印失败，打印机异常，打印机：${defaultPrinter}, 打印机状态：${StatusMsg}`,
      );
      socket &&
        socket.emit("error", {
          msg: data.printer + "打印机异常",
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

      const htmlString = JSON.stringify(svgPages.join(""));
      const styleString = JSON.stringify(`
        #printElement {
          margin: 0;
          padding: 0;
        }
        .svg-page {
          page-break-after: always;
          break-after: page;
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .svg-page:last-child {
          page-break-after: auto;
          break-after: auto;
        }
        .svg-page svg {
          display: block;
          max-width: 100%;
          max-height: 100%;
        }
      `);
      const titleString = JSON.stringify(data.title ? data.title : "SVG批量打印");
      await PRINT_WINDOW.webContents.executeJavaScript(`
        document.title = ${titleString};
        const styleId = "svg-batch-print-style";
        const oldStyle = document.getElementById(styleId);
        if (oldStyle) {
          oldStyle.remove();
        }
        const styleElement = document.createElement("style");
        styleElement.id = styleId;
        styleElement.textContent = ${styleString};
        document.head.appendChild(styleElement);
        const printElement = document.getElementById("printElement");
        if (!printElement) {
          throw new Error("找不到printElement容器");
        }
        printElement.innerHTML = ${htmlString};
        true;
      `);

      PRINT_WINDOW.webContents.print(
        {
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
          pageRanges: data.pageRanges ?? {},
          duplexMode: data.duplexMode,
          dpi: data.dpi ?? 300,
          header: data.header,
          footer: data.footer,
          pageSize: data.pageSize,
        },
        (success, failureReason) => {
          if (success) {
            onSuccess();
            return;
          }
          onFail({ message: failureReason || "未知错误" });
        },
      );
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

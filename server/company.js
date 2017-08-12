'use strict';
import { _ } from 'meteor/underscore';
import { resourceManager } from './resourceManager';
import { changeStocksAmount, resolveOrder, updateCompanyLastPrice } from './methods/order';
import { dbCompanies } from '../db/dbCompanies';
import { dbOrders } from '../db/dbOrders';
import { dbDirectors } from '../db/dbDirectors';
import { dbLog } from '../db/dbLog';
import { dbSeason } from '../db/dbSeason';
import { config } from '../config';

let releaseStocksCounter = generateReleaseStocksConter();
export function releaseStocks() {
  releaseStocksCounter -= 1;
  if (releaseStocksCounter <= 0) {
    releaseStocksCounter = generateReleaseStocksConter();
    const maxPriceCompany = dbCompanies.findOne({}, {
      sort: {
        lastPrice: -1
      }
    });
    if (! maxPriceCompany) {
      return false;
    }
    //釋股門檻價格
    const thresholdPrice = Math.round(maxPriceCompany.lastPrice / 2);
    dbCompanies
      .find(
        {
          lastPrice: {
            $gt: thresholdPrice
          }
        },
        {
          fields: {
            _id: 1,
            companyName: 1,
            manager: 1,
            lastPrice: 1,
            listPrice: 1,
            totalRelease: 1,
            profit: 1,
            totalValue: 1
          },
          disableOplog: true
        }
      )
      .forEach((companyData) => {
        const companyName = companyData.companyName;
        const existsReleaseOrder = dbOrders.findOne({
          companyName: companyName,
          username: '!system'
        });
        //有尚存在的釋股單在市場上時不繼續釋股
        if (existsReleaseOrder) {
          return false;
        }
        //先鎖定資源，再重新讀取一次資料進行運算
        resourceManager.request('releaseStocks', ['season', 'companyOrder' + companyName], (release) => {
          const companyData = dbCompanies.findOne({companyName}, {
            fields: {
              _id: 1,
              companyName: 1,
              manager: 1,
              lastPrice: 1,
              listPrice: 1,
              totalRelease: 1,
              profit: 1,
              totalValue: 1
            }
          });
          const maxReleaseStocks = Math.floor(companyData.totalRelease * 0.05);
          const releaseStocks = 1 + Math.floor(Math.random() * Math.min(companyData.lastPrice - thresholdPrice, maxReleaseStocks) / 2);
          dbLog.insert({
            logType: '公司釋股',
            companyName: companyName,
            amount: releaseStocks,
            price: companyData.listPrice,
            resolve: false,
            createdAt: new Date()
          });
          dbCompanies.update(companyData._id, {
            $inc: {
              totalRelease: releaseStocks
            }
          });
          let alreadyRelease = 0;
          let lastPrice = companyData.lastPrice;
          dbOrders
            .find(
              {
                companyName: companyName,
                orderType: '購入',
                unitPrice: {
                  $gte: companyData.listPrice
                }
              },
              {
                sort: {
                  unitPrice: -1,
                  createdAt: 1
                },
                disableOplog: true
              }
            )
            .forEach((buyOrderData) => {
              if (alreadyRelease >= releaseStocks) {
                return true;
              }
              const tradeNumber = Math.min(buyOrderData.amount - buyOrderData.done, releaseStocks - alreadyRelease);
              if (tradeNumber > 0) {
                alreadyRelease += tradeNumber;
                lastPrice = buyOrderData.unitPrice;
                dbLog.insert({
                  logType: '交易紀錄',
                  username: [buyOrderData.username],
                  companyName: companyName,
                  price: lastPrice,
                  amount: tradeNumber,
                  createdAt: new Date()
                });
                changeStocksAmount(buyOrderData.username, companyName, tradeNumber);
                dbCompanies.update({companyName}, {
                  $inc: {
                    profit: lastPrice * tradeNumber
                  }
                });
              }
              resolveOrder(buyOrderData, tradeNumber);
            });
          updateCompanyLastPrice(companyData, lastPrice);
          if (alreadyRelease < releaseStocks) {
            dbOrders.insert({
              companyName: companyName,
              username: '!system',
              orderType: '賣出',
              unitPrice: companyData.listPrice,
              amount: releaseStocks,
              done: alreadyRelease,
              createdAt: new Date()
            });
          }
          release();
        });
      });
  }
}

function generateReleaseStocksConter() {
  const min = config.releaseStocksMinCounter;
  const max = (config.releaseStocksMaxCounter - min);

  return min + Math.floor(Math.random() * max);
}

let recordListPriceConter = generateRecordListPriceConter();
export function recordListPrice() {
  recordListPriceConter -= 1;
  if (recordListPriceConter <= 0) {
    recordListPriceConter = generateRecordListPriceConter();
    dbCompanies
      .find(
        {},
        {
          fields: {
            _id: 1,
            companyName: 1,
            lastPrice: 1,
            listPrice: 1
          },
          disableOplog: true
        }
      )
      .forEach((companyData) => {
        if (companyData.lastPrice !== companyData.listPrice) {
          const companyName = companyData.companyName;
          //先鎖定資源，再重新讀取一次資料進行運算
          resourceManager.request('recordListPrice', ['season', 'companyOrder' + companyName], (release) => {
            const companyData = dbCompanies.findOne({companyName}, {
              fields: {
                _id: 1,
                lastPrice: 1,
                totalRelease: 1
              }
            });
            dbCompanies.update(companyData._id, {
              $set: {
                listPrice: companyData.lastPrice,
                totalValue: companyData.lastPrice * companyData.totalRelease
              }
            });
            release();
          });
        }
      });
  }
}

function generateRecordListPriceConter() {
  const min = config.recordListPriceMinCounter;
  const max = (config.recordListPriceMaxCounter - min);

  return min + Math.floor(Math.random() * max);
}

function convertDateToText(date) {
  const dateInTimeZone = new Date(date.getTime() + date.getTimezoneOffset() * 60 * 1000 * -1);

  return (
    dateInTimeZone.getFullYear() + '/' +
    padZero(dateInTimeZone.getMonth() + 1) + '/' +
    padZero(dateInTimeZone.getDate()) + ' ' +
    padZero(dateInTimeZone.getHours()) + ':' +
    padZero(dateInTimeZone.getMinutes())
  );
}
function padZero(n) {
  if (n < 10) {
    return '0' + n;
  }
  else {
    return n;
  }
}


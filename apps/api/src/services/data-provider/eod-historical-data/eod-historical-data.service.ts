import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import {
  DataProviderInterface,
  GetAssetProfileParams,
  GetDividendsParams,
  GetHistoricalParams,
  GetQuotesParams,
  GetSearchParams
} from '@ghostfolio/api/services/data-provider/interfaces/data-provider.interface';
import {
  IDataProviderHistoricalResponse,
  IDataProviderResponse
} from '@ghostfolio/api/services/interfaces/interfaces';
import { SymbolProfileService } from '@ghostfolio/api/services/symbol-profile/symbol-profile.service';
import {
  DEFAULT_CURRENCY,
  REPLACE_NAME_PARTS
} from '@ghostfolio/common/config';
import { DATE_FORMAT, isCurrency } from '@ghostfolio/common/helper';
import {
  DataProviderInfo,
  LookupItem,
  LookupResponse
} from '@ghostfolio/common/interfaces';
import { MarketState } from '@ghostfolio/common/types';

import { Injectable, Logger } from '@nestjs/common';
import {
  AssetClass,
  AssetSubClass,
  DataSource,
  SymbolProfile
} from '@prisma/client';
import { addDays, format, isSameDay, isToday } from 'date-fns';
import { isNumber } from 'lodash';

@Injectable()
export class EodHistoricalDataService implements DataProviderInterface {
  private apiKey: string;
  private readonly URL = 'https://eodhistoricaldata.com/api';

  public constructor(
    private readonly configurationService: ConfigurationService,
    private readonly symbolProfileService: SymbolProfileService
  ) {
    this.apiKey = this.configurationService.get('API_KEY_EOD_HISTORICAL_DATA');
  }

  public canHandle() {
    return true;
  }

  public async getAssetProfile({
    symbol
  }: GetAssetProfileParams): Promise<Partial<SymbolProfile>> {
    const [searchResult] = await this.getSearchResult(symbol);

    return {
      symbol,
      assetClass: searchResult?.assetClass,
      assetSubClass: searchResult?.assetSubClass,
      currency: this.convertCurrency(searchResult?.currency),
      dataSource: this.getName(),
      isin: searchResult?.isin,
      name: searchResult?.name
    };
  }

  public getDataProviderInfo(): DataProviderInfo {
    return {
      dataSource: DataSource.EOD_HISTORICAL_DATA,
      isPremium: true,
      name: 'EOD Historical Data',
      url: 'https://eodhd.com'
    };
  }

  public async getDividends({
    from,
    requestTimeout = this.configurationService.get('REQUEST_TIMEOUT'),
    symbol,
    to
  }: GetDividendsParams): Promise<{
    [date: string]: IDataProviderHistoricalResponse;
  }> {
    symbol = this.convertToEodSymbol(symbol);

    if (isSameDay(from, to)) {
      to = addDays(to, 1);
    }

    try {
      const response: {
        [date: string]: IDataProviderHistoricalResponse;
      } = {};

      const historicalResult = await fetch(
        `${this.URL}/div/${symbol}?api_token=${
          this.apiKey
        }&fmt=json&from=${format(from, DATE_FORMAT)}&to=${format(
          to,
          DATE_FORMAT
        )}`,
        {
          signal: AbortSignal.timeout(requestTimeout)
        }
      ).then((res) => res.json());

      for (const { date, value } of historicalResult) {
        response[date] = {
          marketPrice: value
        };
      }

      return response;
    } catch (error) {
      Logger.error(
        `Could not get dividends for ${symbol} (${this.getName()}) from ${format(
          from,
          DATE_FORMAT
        )} to ${format(to, DATE_FORMAT)}: [${error.name}] ${error.message}`,
        'EodHistoricalDataService'
      );

      return {};
    }
  }

  public async getHistorical({
    from,
    granularity = 'day',
    requestTimeout = this.configurationService.get('REQUEST_TIMEOUT'),
    symbol,
    to
  }: GetHistoricalParams): Promise<{
    [symbol: string]: { [date: string]: IDataProviderHistoricalResponse };
  }> {
    symbol = this.convertToEodSymbol(symbol);

    try {
      const response = await fetch(
        `${this.URL}/eod/${symbol}?api_token=${
          this.apiKey
        }&fmt=json&from=${format(from, DATE_FORMAT)}&to=${format(
          to,
          DATE_FORMAT
        )}&period=${granularity}`,
        {
          signal: AbortSignal.timeout(requestTimeout)
        }
      ).then((res) => res.json());

      return response.reduce(
        (result, { adjusted_close, date }) => {
          if (isNumber(adjusted_close)) {
            result[this.convertFromEodSymbol(symbol)][date] = {
              marketPrice: adjusted_close
            };
          } else {
            Logger.error(
              `Could not get historical market data for ${symbol} (${this.getName()}) at ${date}`,
              'EodHistoricalDataService'
            );
          }

          return result;
        },
        { [this.convertFromEodSymbol(symbol)]: {} }
      );
    } catch (error) {
      throw new Error(
        `Could not get historical market data for ${symbol} (${this.getName()}) from ${format(
          from,
          DATE_FORMAT
        )} to ${format(to, DATE_FORMAT)}: [${error.name}] ${error.message}`
      );
    }
  }

  public getMaxNumberOfSymbolsPerRequest() {
    // It is not recommended using more than 15-20 tickers per request
    // https://eodhistoricaldata.com/financial-apis/live-realtime-stocks-api
    return 20;
  }

  public getName(): DataSource {
    return DataSource.EOD_HISTORICAL_DATA;
  }

  public async getQuotes({
    requestTimeout = this.configurationService.get('REQUEST_TIMEOUT'),
    symbols
  }: GetQuotesParams): Promise<{ [symbol: string]: IDataProviderResponse }> {
    const response: { [symbol: string]: IDataProviderResponse } = {};

    if (symbols.length <= 0) {
      return response;
    }

    const eodHistoricalDataSymbols = symbols.map((symbol) => {
      return this.convertToEodSymbol(symbol);
    });

    try {
      const realTimeResponse = await fetch(
        `${this.URL}/real-time/${eodHistoricalDataSymbols[0]}?api_token=${
          this.apiKey
        }&fmt=json&s=${eodHistoricalDataSymbols.join(',')}`,
        {
          signal: AbortSignal.timeout(requestTimeout)
        }
      ).then((res) => res.json());

      const quotes: {
        close: number;
        code: string;
        previousClose: number;
        timestamp: number;
      }[] =
        eodHistoricalDataSymbols.length === 1
          ? [realTimeResponse]
          : realTimeResponse;

      const symbolProfiles = await this.symbolProfileService.getSymbolProfiles(
        symbols.map((symbol) => {
          return {
            symbol,
            dataSource: this.getName()
          };
        })
      );

      for (const { close, code, previousClose, timestamp } of quotes) {
        let currency: string;

        if (this.isForex(code)) {
          currency = this.convertFromEodSymbol(code)?.replace(
            DEFAULT_CURRENCY,
            ''
          );
        }

        if (!currency) {
          currency = symbolProfiles.find(({ symbol }) => {
            return symbol === code;
          })?.currency;
        }

        if (!currency) {
          const { items } = await this.search({ query: code });

          if (items.length === 1) {
            currency = items[0].currency;
          }
        }

        if (isNumber(close) || isNumber(previousClose)) {
          const marketPrice: number = isNumber(close) ? close : previousClose;
          let marketState: MarketState = 'closed';

          if (this.isForex(code) || isToday(new Date(timestamp * 1000))) {
            marketState = 'open';
          } else if (!isNumber(close)) {
            marketState = 'delayed';
          }

          response[this.convertFromEodSymbol(code)] = {
            currency,
            marketPrice,
            marketState,
            dataSource: this.getName()
          };
        } else {
          Logger.error(
            `Could not get quote for ${this.convertFromEodSymbol(code)} (${this.getName()})`,
            'EodHistoricalDataService'
          );
        }
      }

      return response;
    } catch (error) {
      let message = error;

      if (error?.name === 'AbortError') {
        message = `RequestError: The operation to get the quotes was aborted because the request to the data provider took more than ${(
          this.configurationService.get('REQUEST_TIMEOUT') / 1000
        ).toFixed(3)} seconds`;
      }

      Logger.error(message, 'EodHistoricalDataService');
    }

    return {};
  }

  public getTestSymbol() {
    return 'AAPL.US';
  }

  public async search({ query }: GetSearchParams): Promise<LookupResponse> {
    const searchResult = await this.getSearchResult(query);

    return {
      items: searchResult
        .filter(({ currency, symbol }) => {
          // Remove 'NA' currency and exchange rates
          return currency?.length === 3 && !this.isForex(symbol);
        })
        .map(
          ({
            assetClass,
            assetSubClass,
            currency,
            dataSource,
            name,
            symbol
          }) => {
            return {
              assetClass,
              assetSubClass,
              dataSource,
              name,
              symbol,
              currency: this.convertCurrency(currency),
              dataProviderInfo: this.getDataProviderInfo()
            };
          }
        )
    };
  }

  private convertCurrency(aCurrency: string) {
    let currency = aCurrency;

    if (currency === 'GBX') {
      currency = 'GBp';
    }

    return currency;
  }

  private convertFromEodSymbol(aEodSymbol: string) {
    let symbol = aEodSymbol;

    if (this.isForex(symbol)) {
      symbol = symbol.replace('GBX', 'GBp');
      symbol = symbol.replace('.FOREX', '');
    }

    return symbol;
  }

  /**
   * Converts a symbol to a EOD symbol
   *
   * Currency:  USDCHF  -> USDCHF.FOREX
   */
  private convertToEodSymbol(aSymbol: string) {
    if (
      aSymbol.startsWith(DEFAULT_CURRENCY) &&
      aSymbol.length > DEFAULT_CURRENCY.length
    ) {
      if (
        isCurrency(
          aSymbol.substring(0, aSymbol.length - DEFAULT_CURRENCY.length)
        )
      ) {
        let symbol = aSymbol;
        symbol = symbol.replace('GBp', 'GBX');

        return `${symbol}.FOREX`;
      }
    }

    return aSymbol;
  }

  private formatName({ name }: { name: string }) {
    if (name) {
      for (const part of REPLACE_NAME_PARTS) {
        name = name.replace(part, '');
      }

      name = name.trim();
    }

    return name;
  }

  private async getSearchResult(aQuery: string) {
    let searchResult: (LookupItem & {
      assetClass: AssetClass;
      assetSubClass: AssetSubClass;
      isin: string;
    })[] = [];

    try {
      const response = await fetch(
        `${this.URL}/search/${aQuery}?api_token=${this.apiKey}`,
        {
          signal: AbortSignal.timeout(
            this.configurationService.get('REQUEST_TIMEOUT')
          )
        }
      ).then((res) => res.json());

      searchResult = response.map(
        ({ Code, Currency, Exchange, ISIN: isin, Name: name, Type }) => {
          const { assetClass, assetSubClass } = this.parseAssetClass({
            Exchange,
            Type
          });

          return {
            assetClass,
            assetSubClass,
            isin,
            currency: this.convertCurrency(Currency),
            dataSource: this.getName(),
            name: this.formatName({ name }),
            symbol: `${Code}.${Exchange}`
          };
        }
      );
    } catch (error) {
      let message = error;

      if (error?.name === 'AbortError') {
        message = `RequestError: The operation to search for ${aQuery} was aborted because the request to the data provider took more than ${(
          this.configurationService.get('REQUEST_TIMEOUT') / 1000
        ).toFixed(3)} seconds`;
      }

      Logger.error(message, 'EodHistoricalDataService');
    }

    return searchResult;
  }

  private isForex(aCode: string) {
    return aCode?.endsWith('.FOREX') || false;
  }

  private parseAssetClass({
    Exchange,
    Type
  }: {
    Exchange: string;
    Type: string;
  }): {
    assetClass: AssetClass;
    assetSubClass: AssetSubClass;
  } {
    let assetClass: AssetClass;
    let assetSubClass: AssetSubClass;

    switch (Type?.toLowerCase()) {
      case 'common stock':
        assetClass = AssetClass.EQUITY;
        assetSubClass = AssetSubClass.STOCK;
        break;
      case 'currency':
        assetClass = AssetClass.LIQUIDITY;

        if (Exchange?.toLowerCase() === 'cc') {
          assetSubClass = AssetSubClass.CRYPTOCURRENCY;
        }

        break;
      case 'etf':
        assetClass = AssetClass.EQUITY;
        assetSubClass = AssetSubClass.ETF;
        break;
      case 'fund':
        assetClass = AssetClass.EQUITY;
        assetSubClass = AssetSubClass.MUTUALFUND;
        break;
    }

    return { assetClass, assetSubClass };
  }
}

import { Bot, type BotConfig, type Context } from "grammy";
import { proxyAwareFetch } from "./proxy.js";

type GrammyClientConfig = NonNullable<BotConfig<Context>["client"]>;
type GrammyBaseFetchConfig = NonNullable<GrammyClientConfig["baseFetchConfig"]>;

export function createGrammyBot(token: string): Bot {
  return new Bot(token, {
    client: grammyClientConfig()
  });
}

export function grammyClientConfig(): GrammyClientConfig {
  return {
    fetch: proxyAwareFetch,
    baseFetchConfig: {
      agent: undefined
    } as GrammyBaseFetchConfig
  };
}

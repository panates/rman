import { Service } from '../core/service.js';

export class ConfigService extends Service {}

declare module '../core/service.js' {
  interface ServiceMap {
    config: ConfigService;
  }
}

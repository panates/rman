import { Service } from '../core/classes/service.js';

export class ConfigService extends Service {}

declare module '../core/classes/service.js' {
  interface ServiceMap {
    config: ConfigService;
  }
}

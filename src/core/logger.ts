import logger from 'npmlog';

logger.addLevel("success", 1500, {fg: "green", bold: true});
logger.addLevel('output', 3300, {}, '');

declare module 'npmlog' {
    interface Logger {
        output(prefix: string, message: string, ...args: any[]): void;

        success(prefix: string, message: string, ...args: any[]): void;

        disp: Record<string, string>;

        showProgress();

        hideProgress();
    }

}

export interface IWorkspaceProvider {
  parse: (root: string) => IWorkspaceInfo | undefined;
}

export interface IWorkspaceInfo {
  dirname: string;
  pkgJson: any;
  packages: string[];
}

export interface Logger {
  info: (message?: any, ...optionalParams: any[]) => void;
  error: (message?: any, ...optionalParams: any[]) => void;
  log: (message?: any, ...optionalParams: any[]) => void;
  warn: (message?: any, ...optionalParams: any[]) => void;
}

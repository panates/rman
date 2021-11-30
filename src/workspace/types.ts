export interface IWorkspaceOptions {
    packageOrder?: string[];
}

export interface IWorkspaceProvider {
    parse: (root: string) => IParsedWorkspaceInfo | undefined;
}

export interface IParsedWorkspaceInfo {
    root: string;
    packages: string[];
}

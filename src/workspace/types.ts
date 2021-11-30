export interface IWorkspaceOptions {
    packageOrder?: string[];
    scripts?: Record<string, {
    }>;
}

export interface IWorkspaceProvider {
    parse: (root: string) => Promise<IParsedWorkspaceInfo | undefined>;
}

export interface IParsedWorkspaceInfo {
    root: string;
    packages: string[];
}

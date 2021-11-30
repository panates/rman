import {IParsedWorkspaceInfo, IWorkspaceProvider} from '../types';
import {getPackageJson} from '../utils.js';

export class NpmProvider implements IWorkspaceProvider {

    async parse(root: string): Promise<IParsedWorkspaceInfo | undefined> {
        const pkg = getPackageJson(root);
        if (pkg && typeof pkg.workspaces === 'object') {
            if (Array.isArray(pkg.workspaces))
                return {root, packages: pkg.workspaces}
            if (Array.isArray(pkg.workspaces.packages))
                return {root, packages: pkg.workspaces.packages}
        }

    }
}

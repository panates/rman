import {IWorkspaceInfo, IWorkspaceProvider} from '../types';
import {getPackageJson} from '../../utils';

export class NpmProvider implements IWorkspaceProvider {

    parse(root: string): IWorkspaceInfo | undefined {
        const pkgJson = getPackageJson(root);
        if (pkgJson && typeof pkgJson.workspaces === 'object') {
            if (Array.isArray(pkgJson.workspaces))
                return {dirname: root, pkgJson, packages: pkgJson.workspaces}
            if (Array.isArray(pkgJson.workspaces.packages))
                return {dirname: root, pkgJson, packages: pkgJson.workspaces.packages}
        }

    }
}

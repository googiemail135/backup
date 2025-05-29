const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');
const os = require('os');

const TOOL_DIR = 'backupTool';
const TOOL_SCRIPT = 'backupTool.js';
const CONFIG_FILE = 'backup-config.json';

const SCRIPT_DIR = __dirname;
const SCRIPT_PATH = __filename;

const isOpMode = SCRIPT_DIR.endsWith(path.join(path.sep, TOOL_DIR));
const projectRoot = isOpMode ? path.resolve(SCRIPT_DIR, '..') : '';
let configFilePath;

if (isOpMode) {
    configFilePath = path.join(SCRIPT_DIR, CONFIG_FILE);
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function getFormattedTimestamp() {
    const now = new Date();
    const utc7Offset = 7 * 60 * 60 * 1000;
    const utc7Date = new Date(now.getTime() + utc7Offset);
    return utc7Date.toISOString().replace('T', ' ').substring(0, 19);
}

function askQuestion(query) {
    return new Promise(resolve => rl.question(query, ans => resolve(ans.trim())));
}

function runCommand(command, options = {}, suppressErrorLogging = false) {
    try {
        console.log(`Executing: ${command}`);
        const output = execSync(command, { stdio: 'pipe', encoding: 'utf8', ...options }).toString().trim();
        if (output) console.log(`Output: ${output}`);
        return output;
    } catch (error) {
        const errMsg = error.stderr ? error.stderr.toString().trim() : error.message;
        if (!suppressErrorLogging) {
            console.error(`Cmd Error for "${command}": ${errMsg}`, error.stack || error);
        }
        throw error;
    }
}

function runCommandStdIO(command, options = {}) {
    try {
        console.log(`Executing (stdio): ${command}`);
        execSync(command, { stdio: 'inherit', ...options });
        return true;
    } catch (error) {
        console.error(`Cmd Error (stdio) for "${command}": ${error.message}`, error.stack || error);
        throw error;
    }
}

function checkCommandExists(command) {
    try {
        const checkCmd = process.platform === 'win32' ? `where ${command}` : `command -v ${command}`;
        execSync(checkCmd, { stdio: 'ignore' });
        return true;
    } catch (error) {
        return false;
    }
}

function readConfig() {
    if (!configFilePath || !fs.existsSync(configFilePath)) {
        console.warn(`Config file not found: ${configFilePath}`);
        return null;
    }
    try {
        const rawData = fs.readFileSync(configFilePath, 'utf8');
        return JSON.parse(rawData);
    } catch (error) {
        console.error(`Error reading config ${configFilePath}: ${error.message}`, error.stack || error);
        return null;
    }
}

function updateConfig(newConfigData) {
    if (!configFilePath) {
        console.error('Config file path is not set. Cannot update configuration.');
        return false;
    }
    try {
        fs.writeFileSync(configFilePath, JSON.stringify(newConfigData, null, 2), 'utf8');
        console.log(`Configuration updated: ${configFilePath}`);
        return true;
    } catch (error) {
        console.error(`Error writing config ${configFilePath}: ${error.message}`, error.stack || error);
        return false;
    }
}

async function getCurrentGitBranch() {
    try {
        let branch = runCommand('git rev-parse --abbrev-ref HEAD');
        if (!branch || branch.trim() === 'HEAD') {
            branch = runCommand('git branch --show-current');
        }
        if (!branch || branch.trim() === '') {
            throw new Error('Could not determine current branch or in detached HEAD state.');
        }
        const trimmedBranch = branch.trim();
        console.log(`Current branch: ${trimmedBranch}`);
        return trimmedBranch;
    } catch (error) {
        console.error(`Error getting current branch: ${error.message}`, error.stack || error);
        throw error;
    }
}

async function getGitStatus(branchName) {
    console.log(`Fetching Git status for branch ${branchName}...`);
    const status = {
        hasChanges: false,
        isRepo: fs.existsSync(path.join(projectRoot, '.git')),
        sync: 'unknown',
        localHash: '',
        remoteHash: '',
        baseHash: ''
    };

    if (!status.isRepo) {
        console.error('This is not a Git repository. Please run --init to set up.');
        return status;
    }

    try {
        const statusOutput = runCommand('git status --porcelain');
        status.hasChanges = statusOutput.length > 0;
        console.log(status.hasChanges ? 'Local changes detected.' : 'No local changes.');

        runCommand('git remote update');
        status.localHash = runCommand('git rev-parse HEAD');
        const remoteBranchExistsResult = runCommand(`git ls-remote --heads origin ${branchName}`, {}, true);

        if (!remoteBranchExistsResult) {
            console.log(`Remote branch origin/${branchName} not found.`);
            status.sync = 'no_remote';
            return status;
        }

        status.remoteHash = runCommand(`git rev-parse origin/${branchName}`);
        status.baseHash = runCommand(`git merge-base HEAD origin/${branchName}`);

        if (status.localHash === status.remoteHash) status.sync = 'uptodate';
        else if (status.localHash === status.baseHash) status.sync = 'behind';
        else if (status.remoteHash === status.baseHash) status.sync = 'ahead';
        else status.sync = 'diverged';

        console.log(`Sync status with origin/${branchName}: ${status.sync}`);
    } catch (error) {
        console.error(`Error getting Git status for ${branchName}: ${error.message}`, error.stack || error);
        status.sync = 'error';
        if (error.message && (error.message.includes("unknown revision") || error.message.includes("ambiguous argument"))) {
            console.warn(`Possible issue: Remote branch origin/${branchName} may not be tracked or a remote error occurred.`);
        }
    }
    return status;
}

function displaySyncStatus(gitStatus, branchName, operationType) {
    const remoteBranch = `origin/${branchName}`;
    console.log(`${operationType}: Sync status for branch '${branchName}' is ${gitStatus.sync}.`);
    switch (gitStatus.sync) {
        case 'uptodate':
            console.log(`OK: Branch '${branchName}' is up-to-date with ${remoteBranch}.`);
            break;
        case 'behind':
            console.warn(`Warning: Local branch '${branchName}' is behind ${remoteBranch}. Consider pulling changes.`);
            break;
        case 'ahead':
            console.log(`Local branch '${branchName}' is ahead of ${remoteBranch}. Pushing existing commits...`);
            try {
                runCommandStdIO(`git push origin ${branchName}`);
                console.log(`Successfully pushed '${branchName}' to ${remoteBranch}.`);
            } catch (e) {
                console.error(`Error pushing '${branchName}'. Check Git output for details.`, e.stack || e);
            }
            break;
        case 'diverged':
            console.warn(`Warning: Local branch '${branchName}' has diverged from ${remoteBranch}. A merge or rebase is required.`);
            break;
        case 'no_remote':
            console.log(`Remote branch ${remoteBranch} not found. Pushing '${branchName}' as a new remote branch...`);
            try {
                runCommandStdIO(`git push -u origin ${branchName}`);
                console.log(`Successfully pushed '${branchName}' to new remote branch ${remoteBranch}.`);
            } catch (e) {
                console.error(`Error pushing new branch '${branchName}'. Check Git output for details.`, e.stack || e);
            }
            break;
        case 'error':
        default:
            console.log(`Could not reliably determine the sync status for '${branchName}' with ${remoteBranch}.`);
            break;
    }
}

async function commitAndPush(commitMessage, branchName, projectName) {
    console.log(`Attempting to commit "${commitMessage}" and push to origin/${branchName}.`);
    try {
        console.log('Staging all changes...');
        runCommandStdIO('git add -A');
        console.log(`Committing with message: "${commitMessage}"`);
        runCommandStdIO(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`);
        console.log(`Pushing changes to origin/${branchName}...`);
        runCommandStdIO(`git push origin ${branchName}`);
        console.log(`\nOK: Changes committed and pushed to origin/${branchName}.`);
        if (projectName) console.log(`Project '${projectName}' has been backed up.`);
        return true;
    } catch (error) {
        console.error('Commit and push operation failed. Check Git output for details.', error.stack || error);
        if (error.message && error.message.toLowerCase().includes('push')) {
            console.log(`Hint: If this is the first push for this branch, you might need to use: git push --set-upstream origin ${branchName}`);
        }
        return false;
    }
}

async function createProjectConfig(targetProjectRootDir) {
    const toolDirInTarget = path.join(targetProjectRootDir, TOOL_DIR);
    const actualConfigPath = path.join(toolDirInTarget, CONFIG_FILE);
    const projectNameForConfig = path.basename(targetProjectRootDir);

    if (fs.existsSync(actualConfigPath)) {
        console.warn(`Configuration file ${actualConfigPath} already exists. Skipping creation.`);
        return;
    }

    console.log(`Creating default configuration file: ${actualConfigPath}`);
    const defaultConfig = {
        projectName: projectNameForConfig,
        githubUsername: "",
        backupBranch: "main",
        autoIgnoreFiles: [".env*", "*.log", "*.tmp", "node_modules/", ".wrangler/", "dist/", "build/", "__pycache__/", ".vscode/settings.json", "Thumbs.db", ".DS_Store", `/${TOOL_DIR}/`],
        maxBackupAttempts: 5,
        createdAt: getFormattedTimestamp(),
        version: "2.7-nodejs-console-quieter"
    };

    try {
        if (!fs.existsSync(toolDirInTarget)) {
            fs.mkdirSync(toolDirInTarget, { recursive: true });
        }
        fs.writeFileSync(actualConfigPath, JSON.stringify(defaultConfig, null, 2));
        console.log(`Successfully created configuration file: ${actualConfigPath}`);
    } catch (e) {
        console.error(`Failed to create configuration file ${actualConfigPath}: ${e.message}`, e.stack || e);
    }
}

async function updateProjectGitignore(targetDir) {
    const projectGitignorePath = path.join(targetDir, '.gitignore');
    const toolGitignoreContent = `\n# ${TOOL_DIR}\n/${TOOL_DIR}/\n.env*\n*.key\n*.pem\nconfig.local.*\n`;
    const toolGitignoreMarker = `# ${TOOL_DIR}`;

    console.log(`Updating .gitignore file: ${projectGitignorePath}`);

    if (!fs.existsSync(projectGitignorePath)) {
        console.log('.gitignore not found. Creating a new one with tool-specific rules.');
        try {
            fs.writeFileSync(projectGitignorePath, `# Generated by ${TOOL_DIR}\n${toolGitignoreContent}`, 'utf8');
            console.log(`Successfully created .gitignore: ${projectGitignorePath}`);
        } catch (e) {
            console.error(`Error creating .gitignore file ${projectGitignorePath}: ${e.message}.`, e.stack || e);
        }
        return;
    }

    console.log('.gitignore exists. Checking and appending rules if necessary.');
    let gitignoreContent = '';
    try {
        gitignoreContent = fs.readFileSync(projectGitignorePath, 'utf8');
    } catch (e) {
        console.error(`Error reading .gitignore file ${projectGitignorePath}: ${e.message}`, e.stack || e);
        return;
    }

    if (gitignoreContent.includes(toolGitignoreMarker)) {
        console.warn(`.gitignore already contains a section for ${TOOL_DIR}. Skipping modification.`);
        return;
    }

    const rulesToAdd = toolGitignoreContent.split('\n').filter(rule => {
        const trimmedRule = rule.trim();
        if (trimmedRule === '') return false;
        const ruleToCheck = trimmedRule.endsWith('/') ? trimmedRule.slice(0, -1) : trimmedRule;
        return !gitignoreContent.includes(ruleToCheck);
    });

    let contentToAppend;
    if (rulesToAdd.length > 0) {
        contentToAppend = (gitignoreContent.includes(toolGitignoreMarker) ? '\n' : `\n${toolGitignoreMarker}\n# ${TOOL_DIR} rules\n`) + rulesToAdd.join('\n') + '\n';
    } else if (!gitignoreContent.includes(`/${TOOL_DIR}/`)) {
        contentToAppend = `\n${toolGitignoreMarker}\n/${TOOL_DIR}/\n`;
    } else {
        contentToAppend = "";
    }

    if (contentToAppend) {
        try {
            let prefix = "";
            if (gitignoreContent.length > 0 && !gitignoreContent.endsWith('\n')) {
                prefix = '\n';
            } else if (gitignoreContent.length > 0 && gitignoreContent.endsWith('\n') && !gitignoreContent.endsWith('\n\n') && !contentToAppend.startsWith('\n')) {
                 prefix = '\n';
            }
            fs.appendFileSync(projectGitignorePath, prefix + contentToAppend, 'utf8');
            console.log('.gitignore file has been updated.');
        } catch (e) {
            console.error(`Error appending to .gitignore file ${projectGitignorePath}: ${e.message}`, e.stack || e);
        }
    } else {
        console.log(`All necessary ${TOOL_DIR} .gitignore rules seem to be present. No changes made.`);
    }
}

async function handleInstallMode() {
    console.log(`\n=== ${TOOL_DIR} Installer ===`);
    console.log(`This process will copy ${TOOL_DIR} and its configuration to your project.\n`);

    let targetDir = process.argv[2] || '';
    if (!targetDir) {
        targetDir = await askQuestion('Please enter the path to your project folder: ');
    }
    if (!targetDir) {
        console.error('Error: No target directory was specified. Installation aborted.');
        return;
    }
    targetDir = path.resolve(targetDir.replace(/["']/g, ''));

    if (!fs.existsSync(targetDir) || !fs.lstatSync(targetDir).isDirectory()) {
        console.error(`Error: The specified directory ${targetDir} does not exist or is not a directory.`);
        return;
    }
    console.log(`Target project directory: ${targetDir}\n`);

    const toolDirInProject = path.join(targetDir, TOOL_DIR);
    if (fs.existsSync(toolDirInProject)) {
        console.warn(`The tool directory (${toolDirInProject}) already exists in the target project.`);
        const overwrite = await askQuestion('Do you want to overwrite it? (Y/N): ');
        if (overwrite.toLowerCase() !== 'y') {
            console.log('Installation cancelled by user.');
            return;
        }
        console.log(`Removing existing tool directory: ${toolDirInProject}`);
        try {
            fs.rmSync(toolDirInProject, { recursive: true, force: true });
        } catch (e) {
            console.error(`Error removing existing directory: ${e.message}`, e.stack || e);
            return;
        }
    }

    console.log(`Creating tool directory: "${toolDirInProject}"...`);
    try {
        fs.mkdirSync(toolDirInProject, { recursive: true });
    } catch (e) {
        console.error(`Failed to create tool directory ${toolDirInProject}: ${e.message}`, e.stack || e);
        return;
    }

    console.log('Copying tool script to the project...');
    const toolScriptInProject = path.join(toolDirInProject, TOOL_SCRIPT);
    try {
        fs.copyFileSync(SCRIPT_PATH, toolScriptInProject);
        if (process.platform !== 'win32') {
            fs.chmodSync(toolScriptInProject, 0o755);
        }
    } catch (e) {
        console.error(`Failed to copy tool script: ${e.message}`, e.stack || e);
        return;
    }

    await createProjectConfig(targetDir);
    await updateProjectGitignore(targetDir);

    console.log(`\nOK: ${TOOL_DIR} has been successfully installed to ${targetDir}\n`);
    console.log('Next steps:');
    console.log(`1. Navigate to your project: cd "${targetDir}"`);
    console.log(`2. Initialize the tool: node "${path.join(TOOL_DIR, TOOL_SCRIPT)}" --init`);

    const runSetupNow = await askQuestion(`Would you like to run the initial setup for ${targetDir} now? (Y/N): `);
    if (runSetupNow.toLowerCase() === 'y') {
        console.log(`Running initial setup in ${targetDir}...`);
        try {
            execSync(`node "${toolScriptInProject}" --init`, { cwd: targetDir, stdio: 'inherit' });
        } catch (e) {
            console.error(`Error running initial setup: ${e.message}`, e.stack || e);
        }
    }
    console.log(`Installation process complete for ${targetDir}.`);
}

async function setupGitRepo() {
    console.log(`Performing Git repository setup for: ${projectRoot}`);
    if (!fs.existsSync(path.join(projectRoot, '.git'))) {
        console.log('Initializing a new Git repository...');
        try {
            runCommandStdIO('git init');
            runCommandStdIO('git add .');
            runCommandStdIO(`git commit -m "Initial commit - ${TOOL_DIR} setup"`);
            console.log('Git repository initialized successfully.');
        } catch (e) {
            console.error('Git initialization failed. Setup cannot continue.', e.stack || e);
            return false;
        }
    } else {
        console.log('OK: Git repository already exists.');
    }
    return true;
}

async function setupGitIdentity() {
    console.log('\n=== Git User Identity Setup ===');
    let userName = '';
    let userEmail = '';
    const placeholderNames = ['GitHub Backup User', 'backup user', 'test user', 'dummy user'];
    const placeholderEmails = ['backup@example.com', 'test@example.com', 'user@example.com', 'dummy@example.com'];
    try {
        userName = runCommand('git config --global user.name');
        userEmail = runCommand('git config --global user.email');
        const isPlaceholderName = placeholderNames.some(placeholder => 
            userName.toLowerCase().includes(placeholder.toLowerCase())
        );
        const isPlaceholderEmail = placeholderEmails.some(placeholder => 
            userEmail.toLowerCase().includes(placeholder.toLowerCase())
        );
        if (isPlaceholderName || isPlaceholderEmail) {
            console.log(`Detected placeholder Git identity: Name: ${userName}, Email: ${userEmail}`);
            console.log('This appears to be old or placeholder data. Getting current user info from GitHub...');
            throw new Error("Placeholder identity detected");
        }
        console.log(`Current global Git identity: Name: ${userName}, Email: ${userEmail}`);
        if ((await askQuestion('Do you want to use this current global identity? (Y/N): ')).toLowerCase() === 'y') {
            return true;
        }
        throw new Error("User requested new identity setup.");
    } catch (error) {
        console.log('Setting up new Git identity from GitHub CLI...');
        try {
            if (checkCommandExists('gh')) {
                try {
                    runCommand('gh auth status', {}, true);
                    console.log('Getting user information from authenticated GitHub account...');
                    const ghUserData = runCommand('gh api user');
                    const userData = JSON.parse(ghUserData);
                    userName = userData.name || userData.login;
                    userEmail = userData.email;
                    if (!userEmail) {
                        try {
                            const emailData = runCommand('gh api user/emails', {}, true);
                            const emails = JSON.parse(emailData);
                            const primaryEmail = emails.find(email => email.primary);
                            userEmail = primaryEmail ? primaryEmail.email : emails[0]?.email;
                        } catch (emailError) {
                            console.log('Cannot access email API (missing user scope). Using GitHub username for Git commits.');
                            userEmail = `${userData.login}@users.noreply.github.com`;
                        }
                    }
                    if (userName && userEmail) {
                        console.log(`Retrieved from GitHub: Name: ${userName}, Email: ${userEmail}`);
                        const useGitHubInfo = await askQuestion('Use this GitHub account information for Git commits? (Y/N): ');
                        if (useGitHubInfo.toLowerCase() === 'y') {
                            runCommand(`git config --global user.name "${userName}"`);
                            runCommand(`git config --global user.email "${userEmail}"`);
                            console.log(`Global Git identity set to: Name: ${userName}, Email: ${userEmail}`);
                            return true;
                        }
                    }
                } catch (ghError) {
                    console.log('Could not retrieve information from GitHub CLI. Will prompt for manual entry.');
                }
            }
        } catch (e) {
            console.log('GitHub CLI not available or not authenticated. Will prompt for manual entry.');
        }
        console.log('Please enter your Git identity manually:');
        userName = await askQuestion('Enter your full name for Git commits: ');
        userEmail = await askQuestion('Enter your email for Git commits: ');
        if (!userName || !userEmail) {
            console.error('User name and email cannot be empty. Git identity setup failed.');
            return false;
        }
        try {
            runCommand(`git config --global user.name "${userName}"`);
            runCommand(`git config --global user.email "${userEmail}"`);
            console.log(`Global Git identity set to: Name: ${userName}, Email: ${userEmail}`);
        } catch (e) {
            console.error('Failed to set global Git identity. Setup cannot continue.', e.stack || e);
            return false;
        }
    }
    return true;
}

async function setupGhCli() {
    console.log('\n=== GitHub CLI (gh) Setup ===');
    if (!checkCommandExists('gh')) {
        console.error('GitHub CLI (gh) is not installed. Please install it from: https://cli.github.com/');
        if ((await askQuestion('Do you want to open the download page in your browser? (Y/N): ')).toLowerCase() === 'y') {
            const openCmd = process.platform === 'win32' ? 'start' : 'open';
            execSync(`${openCmd} https://cli.github.com/`);
        }
        console.error('Setup requires GitHub CLI to be installed and authenticated.');
        return false;
    }
    try {
        runCommand('gh auth status', {}, true);
        const ghUser = runCommand('gh api user --jq .login');
        console.log(`OK: GitHub CLI is authenticated as: ${ghUser}`);
    } catch (error) {
        console.log('GitHub CLI is not authenticated. Attempting to log in now (requires scopes: repo, workflow, delete_repo)...');
        try {
            runCommandStdIO('gh auth login --scopes "repo,workflow,delete_repo"');
            console.log('GitHub CLI authenticated successfully.');
        } catch (e) {
            console.error('GitHub CLI authentication failed. Setup cannot continue.', e.stack || e);
            return false;
        }
    }
    return true;
}

async function setupProjectConfigAndGhUser(config) {
    if (!config.githubUsername) {
        console.log('Attempting to get GitHub username from authenticated GitHub CLI...');
        try {
            config.githubUsername = runCommand('gh api user --jq .login');
        } catch (e) {
            console.error('Could not retrieve GitHub username. Ensure GitHub CLI is authenticated ("gh auth status").', e.stack || e);
            return false;
        }
    }
    if (updateConfig(config)) {
        console.log(`Configuration updated: Project Name "${config.projectName}", GitHub Username "${config.githubUsername}".`);
    } else {
        console.error('Failed to update project configuration with GitHub username.');
        return false;
    }
    return true;
}

async function setupRemoteRepo(config) {
    console.log('\n=== GitHub Remote Repository Setup ===');
    console.log(`Project: ${config.projectName}, GitHub User: ${config.githubUsername}\n`);
    let remoteUrl = '';
    let isRemoteValid = false;
    let shouldCreateNew = false;
    try {
        remoteUrl = runCommand('git remote get-url origin', {}, true);
        if (remoteUrl) {
            console.log(`Existing remote 'origin' found: ${remoteUrl}. Verifying its status on GitHub...`);
            try {
                const repoFullNameMatch = remoteUrl.match(/github\.com[/:]([^\/]+\/[^\/.]+?)(\.git)?$/);
                if (repoFullNameMatch && repoFullNameMatch[1]) {
                    const repoFullName = repoFullNameMatch[1];
                    const [remoteUser, remoteRepo] = repoFullName.split('/');
                    if (remoteUser !== config.githubUsername) {
                        console.log(`Remote repository belongs to different user: ${remoteUser} (current user: ${config.githubUsername})`);
                        console.log('This appears to be from a previous machine or different account.');
                        const createNewRepo = await askQuestion(`Do you want to create a new repository under your account (${config.githubUsername}) instead? (Y/N): `);
                        if (createNewRepo.toLowerCase() === 'y') {
                            console.log('Removing old remote and will create new repository...');
                            try {
                                runCommandStdIO('git remote remove origin');
                                console.log('Successfully removed old remote \'origin\'.');
                            } catch (removeError) {
                                console.error(`Failed to remove old remote 'origin': ${removeError.message}`, removeError.stack || removeError);
                            }
                            shouldCreateNew = true;
                        } else {
                            try {
                                runCommand(`gh repo view ${repoFullName}`, {}, true);
                                console.log(`OK: Keeping existing remote 'origin' (${remoteUrl}) - verified accessible.`);
                                isRemoteValid = true;
                            } catch (ghViewError) {
                                console.warn(`Cannot access repository ${repoFullName}. You may not have permissions.`);
                                const forceCreateNew = await askQuestion('Create a new repository under your account instead? (Y/N): ');
                                if (forceCreateNew.toLowerCase() === 'y') {
                                    try {
                                        runCommandStdIO('git remote remove origin');
                                        console.log('Successfully removed inaccessible remote \'origin\'.');
                                    } catch (removeError) {
                                        console.error(`Failed to remove remote 'origin': ${removeError.message}`, removeError.stack || removeError);
                                    }
                                    shouldCreateNew = true;
                                } else {
                                    console.log('Keeping existing remote configuration as requested.');
                                    return remoteUrl;
                                }
                            }
                        }
                    } else {
                        runCommand(`gh repo view ${repoFullName}`, {}, true);
                        console.log(`OK: Remote 'origin' (${remoteUrl}) is valid and accessible on GitHub.`);
                        isRemoteValid = true;
                    }
                } else {
                    console.warn(`Could not parse repository name from ${remoteUrl}. Assuming it's invalid or not a GitHub repo.`);
                    shouldCreateNew = true;
                }
            } catch (ghViewError) {
                console.warn(`Verification of existing remote 'origin' (${remoteUrl}) failed. It may not exist on GitHub or is inaccessible.`);
                console.warn('Will attempt to remove the local remote \'origin\' and create/link a new one.');
                try {
                    runCommandStdIO('git remote remove origin');
                    console.log('Successfully removed invalid local remote \'origin\'.');
                } catch (removeError) {
                    console.error(`Failed to remove local remote 'origin': ${removeError.message}`, removeError.stack || removeError);
                }
                shouldCreateNew = true;
            }
        }
    } catch (e) {
        console.log('No existing remote \'origin\' found for this project.');
        shouldCreateNew = true;
    }
    if (isRemoteValid && !shouldCreateNew) return remoteUrl;
    console.log(`Proceeding to set up a new GitHub repository for project '${config.projectName}'...`);
    let baseRepoName = config.projectName.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_.-]/g, '').replace(/^[-._]+/, '').replace(/[-._]+$/, '') || 'new-backup-repository';
    let repoName = baseRepoName;
    let counter = 0;
    let repoExistsOnGh = false;
    do {
        try {
            runCommand(`gh repo view ${config.githubUsername}/${repoName}`, {}, true);
            repoExistsOnGh = true;
            counter++;
            const oldRepoName = repoName;
            repoName = `${baseRepoName}-${counter}`;
            console.log(`Repository ${config.githubUsername}/${oldRepoName} already exists on GitHub. Trying alternative: ${repoName}`);
        } catch (viewError) {
            repoExistsOnGh = false;
            console.log(`Repository name ${config.githubUsername}/${repoName} appears to be available or inaccessible (which is fine for creation).`);
        }
    } while (repoExistsOnGh);
    console.log(`The new repository will be named: ${config.githubUsername}/${repoName}\n`);
    const isPrivate = (await askQuestion('Should this new GitHub repository be private? (Y/N): ')).toLowerCase() === 'y';
    const visibilityFlag = isPrivate ? '--private' : '--public';
    console.log('Creating the repository on GitHub and linking it as remote \'origin\'...');
    try {
        try { runCommand('git rev-parse --verify HEAD^{commit}', {}, true); }
        catch (e) {
            console.log('No commits found in the local repository. Creating an initial empty commit...');
            try {
                runCommandStdIO('git add -A');
                runCommandStdIO(`git commit --allow-empty -m "Initial commit by ${TOOL_DIR}"`);
            } catch (commitErr) { console.error('Failed to create an initial commit.', commitErr.stack || commitErr); }
        }
        runCommandStdIO(`gh repo create ${config.githubUsername}/${repoName} ${visibilityFlag} --source=. --remote=origin --push -d "Repository for ${config.projectName}, managed by ${TOOL_DIR}"`);
        remoteUrl = `https://github.com/${config.githubUsername}/${repoName}.git`;
        console.log(`OK: Successfully created GitHub repository: ${remoteUrl.replace(/\.git$/, '')} and set it as 'origin'.`);
        return remoteUrl;
    } catch (createError) {
        console.error(`Failed to automatically create GitHub repository '${repoName}'. Error: ${createError.message}`, createError.stack || createError);
        console.error('Please perform these steps manually:');
        console.error(`1. Create a new repository named '${repoName}' on GitHub (public or private as desired).`);
        console.error(`2. Link it to your local repository: git remote add origin https://github.com/${config.githubUsername}/${repoName}.git`);
        console.error('3. Push your initial changes: git push -u origin YOUR_BRANCH_NAME (e.g., main or master)');
        return null;
    }
}

async function opInitBackup() {
    console.log(`\n=== ${TOOL_DIR} - Initial Setup ===`);
    console.log('Operation: --init');
    let config = readConfig();
    const currentProjectNameBasedOnDir = path.basename(projectRoot);
    if (!config) {
        console.log(`Configuration file (${configFilePath}) not found. A default one will be created.`);
        await createProjectConfig(projectRoot);
        config = readConfig();
        if (!config) {
            console.error('Failed to read or create the configuration file. Setup cannot continue.');
            return;
        }
    }
    if (config.projectName !== currentProjectNameBasedOnDir) {
        console.log(`Project name in configuration ("${config.projectName}") differs from current directory name ("${currentProjectNameBasedOnDir}"). Updating configuration.`);
        config.projectName = currentProjectNameBasedOnDir;
        if (!updateConfig(config)) {
            console.error('Failed to update project name in configuration. Setup cannot continue.');
            return;
        }
        config = readConfig();
        if (!config) {
            console.error('Failed to re-read configuration after name update. Setup cannot continue.');
            return;
        }
    }
    if (!await setupGitRepo()) return;
    if (!await setupGitIdentity()) return;
    if (!await setupGhCli()) return;
    if (!await setupProjectConfigAndGhUser(config)) return;
    const freshConfig = readConfig();
    if (!freshConfig) {
        console.error('Failed to re-read configuration before remote repository setup. Setup cannot continue.');
        return;
    }
    const finalRemoteUrl = await setupRemoteRepo(freshConfig);
    if (finalRemoteUrl) {
        console.log('\n=== OK: Initial Setup Complete! ===');
        console.log(`${TOOL_DIR} is now ready for project: ${freshConfig.projectName}`);
        console.log(`Your project is linked to the GitHub repository: ${finalRemoteUrl.replace(/\.git$/, '')}`);
    } else {
        console.warn('\nSetup is incomplete due to issues with GitHub remote repository setup.');
        console.warn('Please review the error messages above and complete the repository setup manually if needed.');
    }
}

async function opQuickBackup() {
    console.log(`\n=== ${TOOL_DIR} - Quick Backup ===`);
    console.log('Operation: --qbackup');
    const config = readConfig();
    if (!config || !config.projectName) {
        console.error('Error: Project configuration is missing or incomplete (projectName not found). Please run --init first.');
        return;
    }
    let currentBranch;
    try {
        currentBranch = await getCurrentGitBranch();
    } catch (e) {
        return;
    }
    const gitStatus = await getGitStatus(currentBranch);
    if (!gitStatus.isRepo) return;
    if (!gitStatus.hasChanges) {
        console.log(`No local changes detected on branch '${currentBranch}'.`);
        displaySyncStatus(gitStatus, currentBranch, 'QuickBackup');
        return;
    }
    console.log(`Local changes found on branch '${currentBranch}'. Proceeding with backup...`);
    const commitMessage = `Quick backup: ${getFormattedTimestamp()}`;
    await commitAndPush(commitMessage, currentBranch, config.projectName);
}

async function opCommitWithMessage(customMessage) {
    console.log(`\n=== ${TOOL_DIR} - Commit with Custom Message ===`);
    console.log('Operation: --commit');
    const config = readConfig();
    if (!config || !config.projectName) {
        console.error('Error: Project configuration is missing or incomplete (projectName not found). Please run --init first.');
        return;
    }
    let currentBranch;
    try {
        currentBranch = await getCurrentGitBranch();
    } catch (e) {
        return;
    }
    let finalCommitMessage = customMessage;
    if (!finalCommitMessage || finalCommitMessage.trim() === '') {
        finalCommitMessage = await askQuestion('Please enter your commit message: ');
        if (!finalCommitMessage || finalCommitMessage.trim() === '') {
            console.log('No commit message provided. Aborting commit operation.');
            return;
        }
    }
    const gitStatus = await getGitStatus(currentBranch);
    if (!gitStatus.isRepo) return;
    if (!gitStatus.hasChanges) {
        const commitEmpty = await askQuestion(`No local changes detected on branch '${currentBranch}'. Do you want to create an empty commit anyway? (Y/N): `);
        if (!commitEmpty.toLowerCase().startsWith('y')) {
            console.log('Commit aborted as there are no local changes and user chose not to create an empty commit.');
            displaySyncStatus(gitStatus, currentBranch, 'CommitWithMessage');
            return;
        }
        console.log('Proceeding with an empty commit as requested.');
    }
    console.log(`Committing changes on branch '${currentBranch}'...`);
    await commitAndPush(finalCommitMessage, currentBranch, config.projectName);
}

async function opBackupToNewBranch() {
    console.log(`\n=== ${TOOL_DIR} - Backup to New Branch ===`);
    console.log('Operation: Backup to a new branch');
    const config = readConfig();
    if (!config || !config.projectName) {
        console.error('Error: Project configuration is missing or incomplete (projectName not found). Please run --init first.');
        return;
    }
    let previousBranch;
    try {
        previousBranch = await getCurrentGitBranch();
    } catch (e) {
        console.error('Could not determine the current branch to switch back to later. Aborting.');
        return;
    }
    let newBranchName = await askQuestion('Enter the name for the new backup branch: ');
    if (!newBranchName || newBranchName.trim() === '') {
        console.log('No branch name provided. Aborting operation.');
        return;
    }
    newBranchName = newBranchName.trim().replace(/\s+/g, '-');
    try {
        console.log(`Creating and switching to new branch: ${newBranchName}...`);
        runCommandStdIO(`git checkout -b ${newBranchName}`);
        console.log(`Successfully switched to new branch: ${newBranchName}`);
        const commitMessage = await askQuestion(`Enter commit message for the new branch '${newBranchName}': `) || `Initial commit for new branch ${newBranchName}`;
        if (await commitAndPush(commitMessage, newBranchName, config.projectName)) {
            console.log(`Successfully backed up to new branch: ${newBranchName}`);
            console.log(`You are currently on branch: ${newBranchName}`);
            console.log(`To switch back to your previous branch, use: git checkout ${previousBranch}`);
        } else {
            console.error('Failed to commit and push to the new branch. Attempting to switch back and clean up.');
            runCommandStdIO(`git checkout ${previousBranch}`);
            runCommandStdIO(`git branch -D ${newBranchName}`);
            console.log(`Switched back to branch ${previousBranch} and attempted to delete the new branch ${newBranchName}.`);
        }
    } catch (error) {
        console.error(`Error during backup to new branch operation: ${error.message}`, error.stack || error);
        try {
            console.log(`Attempting to switch back to original branch: ${previousBranch}`);
            runCommandStdIO(`git checkout ${previousBranch}`);
        } catch (checkoutError) {
            console.error(`Critical error: Failed to switch back to branch ${previousBranch} after an error: ${checkoutError.message}`, checkoutError.stack || checkoutError);
        }
    }
}

async function checkRemoteSync() {
    console.log('\n=== Check Remote Sync Status ===');
    console.log('Operation: Check remote synchronization status');
    let currentBranch;
    try {
        currentBranch = await getCurrentGitBranch();
    } catch (e) {
        return;
    }
    console.log(`Checking remote synchronization for current branch '${currentBranch}'...`);
    const gitStatus = await getGitStatus(currentBranch);
    if (!gitStatus.isRepo) return;
    displaySyncStatus(gitStatus, currentBranch, 'CheckRemoteSync');
}

async function pullChanges() {
    console.log('\n=== Pull Latest Changes ===');
    console.log('Operation: Pull latest changes from remote');
    let currentBranch;
    try {
        currentBranch = await getCurrentGitBranch();
    } catch (e) {
        return;
    }
    console.log(`Attempting to pull latest changes for branch '${currentBranch}' from remote 'origin'...`);
    try {
        runCommandStdIO(`git pull origin ${currentBranch}`);
        console.log(`Successfully pulled latest changes for branch '${currentBranch}'.`);
    } catch (e) {
        console.error(`Error pulling changes for branch '${currentBranch}'. Check Git output for details.`, e.stack || e);
    }
}

async function opCleanOldUserCommits() {
    console.log(`\n=== ${TOOL_DIR} - Clean Old User Commits ===`);
    console.log('Operation: --clean-history');
    const config = readConfig();
    if (!config || !config.githubUsername) {
        console.error('Error: Project configuration is missing. Please run --init first.');
        return;
    }
    let currentBranch;
    try {
        currentBranch = await getCurrentGitBranch();
    } catch (e) {
        return;
    }
    console.log(`Analyzing commit history on branch '${currentBranch}'...`);
    try {
        const logOutput = runCommand('git log --pretty=format:"%H|%an|%ae|%s" --all');
        const commits = logOutput.split('\n').filter(line => line.trim());
        if (commits.length === 0) {
            console.log('No commits found in repository.');
            return;
        }
        const currentUser = config.githubUsername;
        const currentUserCommits = [];
        const oldUserCommits = [];
        commits.forEach(commitLine => {
            const [hash, authorName, authorEmail, subject] = commitLine.split('|');
            const isCurrentUser = authorName === currentUser || 
                                authorEmail.includes(currentUser) ||
                                authorEmail === `${currentUser}@users.noreply.github.com`;
            if (isCurrentUser) {
                currentUserCommits.push({hash, authorName, authorEmail, subject});
            } else {
                oldUserCommits.push({hash, authorName, authorEmail, subject});
            }
        });
        if (oldUserCommits.length === 0) {
            console.log(`No commits from other users found. All commits belong to ${currentUser}.`);
            return;
        }
        console.log(`\nFound ${oldUserCommits.length} commits from other users:`);
        oldUserCommits.forEach((commit, index) => {
            console.log(`${index + 1}. "${commit.subject}" by ${commit.authorName} (${commit.authorEmail})`);
        });
        console.log(`\nFound ${currentUserCommits.length} commits from current user (${currentUser})`);
        const confirmClean = await askQuestion('\nThis will remove ALL commits from other users and keep only your commits. Continue? (Y/N): ');
        if (confirmClean.toLowerCase() !== 'y') {
            console.log('Operation cancelled by user.');
            return;
        }
        if (currentUserCommits.length === 0) {
            console.log('Creating a fresh repository with current files...');
            try {
                runCommandStdIO('git checkout --orphan temp-clean-branch');
                runCommandStdIO('git add -A');
                runCommandStdIO(`git commit -m "Clean repository - Initial commit by ${currentUser}"`);
                runCommandStdIO(`git branch -D ${currentBranch}`);
                runCommandStdIO(`git branch -m ${currentBranch}`);
                console.log(`Successfully created clean repository with only current user commits on branch '${currentBranch}'.`);
            } catch (error) {
                console.error('Error creating clean repository:', error.message);
                return;
            }
        } else {
            console.log('Preserving commits from current user and removing others...');
            try {
                const firstCurrentUserCommit = currentUserCommits[currentUserCommits.length - 1];
                console.log(`Resetting to first commit by ${currentUser}: "${firstCurrentUserCommit.subject}"`);
                runCommandStdIO(`git reset --hard ${firstCurrentUserCommit.hash}`);
                console.log(`Successfully cleaned repository. Now showing only commits from ${currentUser}.`);
            } catch (error) {
                console.error('Error cleaning repository:', error.message);
                return;
            }
        }
        const pushClean = await askQuestion('Force push the cleaned history to remote? (Y/N): ');
        if (pushClean.toLowerCase() === 'y') {
            try {
                console.log('Force pushing cleaned history to remote...');
                runCommandStdIO(`git push --force origin ${currentBranch}`);
                console.log('Successfully pushed cleaned history to remote.');
            } catch (error) {
                console.error('Error force pushing to remote:', error.message);
                console.log('You may need to manually push: git push --force origin ' + currentBranch);
            }
        }
        console.log('\nRepository history has been cleaned successfully.');
    } catch (error) {
        console.error('Error analyzing commit history:', error.message);
    }
}

async function opCleanAllCommits() {
    console.log(`\n=== ${TOOL_DIR} - Clean All Commit History ===`);
    console.log('Operation: --clean-all');
    const config = readConfig();
    if (!config || !config.githubUsername) {
        console.error('Error: Project configuration is missing. Please run --init first.');
        return;
    }
    let currentBranch;
    try {
        currentBranch = await getCurrentGitBranch();
    } catch (e) {
        return;
    }
    console.log(`Current branch: ${currentBranch}`);
    console.log('This will remove ALL commit history and create a fresh repository with current files.');
    const confirmClean = await askQuestion('Continue with cleaning all commit history? (Y/N): ');
    if (confirmClean.toLowerCase() !== 'y') {
        console.log('Operation cancelled by user.');
        return;
    }
    try {
        console.log('Creating orphan branch to preserve current files...');
        runCommandStdIO('git checkout --orphan temp-clean-branch');
        console.log('Adding all current files to new branch...');
        runCommandStdIO('git add -A');
        const commitMessage = `Clean repository - Initial commit by ${config.githubUsername}`;
        console.log(`Creating initial commit: "${commitMessage}"`);
        runCommandStdIO(`git commit -m "${commitMessage}"`);
        console.log(`Deleting old branch: ${currentBranch}`);
        runCommandStdIO(`git branch -D ${currentBranch}`);
        console.log(`Renaming clean branch to: ${currentBranch}`);
        runCommandStdIO(`git branch -m ${currentBranch}`);
        console.log(`Successfully cleaned all commit history on branch '${currentBranch}'.`);
        console.log('Repository now contains only one commit with all current files.');
        const pushClean = await askQuestion('Force push the cleaned history to remote? (Y/N): ');
        if (pushClean.toLowerCase() === 'y') {
            try {
                console.log('Force pushing cleaned history to remote...');
                runCommandStdIO(`git push --force origin ${currentBranch}`);
                console.log('Successfully pushed cleaned history to remote.');
            } catch (error) {
                console.error('Error force pushing to remote:', error.message);
                console.log('You may need to manually push: git push --force origin ' + currentBranch);
            }
        }
        console.log('\nRepository history has been completely cleaned.');
        console.log('All your current files are preserved in a single initial commit.');
    } catch (error) {
        console.error('Error cleaning repository history:', error.message);
        try {
            console.log('Attempting to recover by switching back to original branch...');
            runCommandStdIO(`git checkout ${currentBranch}`);
        } catch (recoverError) {
            console.error('Critical error during cleanup. Please manually check git status.');
        }
    }
}

function showOperationMenu() {
    console.log('\nAvailable commands for operational mode:');
    console.log('  --init                 Initialize or re-configure the backup tool for the current project.');
    console.log('  --qbackup              Perform a quick backup with an automated commit message.');
    console.log('  --commit "Your Message" Backup with a custom commit message.');
    console.log('  --menu                 Show advanced backup options menu (new branch, sync check, pull).');
    console.log('  --clean-history        Remove commits from other users, keep only current user commits.');
    console.log('  --clean-all            Remove ALL commit history, keep only current files as initial commit.');
    console.log('  --delete-repo, --delrepo Delete a specified GitHub repository (interactive).');
    console.log('  --help                 Show this help information.');
    console.log('  (no arguments)         Show this help information.');
}

async function opShowBackupMenu() {
    console.log('\nOperation: --menu (Advanced Backup Options)');
    console.log(`\n=== ${TOOL_DIR} - Advanced Backup Options ===`);
    console.log('1. Backup with custom message (current branch)');
    console.log('2. Create a new branch and backup to it');
    console.log('3. Check remote sync status (current branch)');
    console.log('4. Pull latest changes from remote (current branch)');
    console.log('5. Clean old user commits from history');
    console.log('6. Clean ALL commit history (keep current files only)');
    console.log('0. Cancel and exit menu');
    const choice = await askQuestion('Please choose an option (0-6): ');
    switch (choice) {
        case '1': await opCommitWithMessage(''); break;
        case '2': await opBackupToNewBranch(); break;
        case '3': await checkRemoteSync(); break;
        case '4': await pullChanges(); break;
        case '5': await opCleanOldUserCommits(); break;
        case '6': await opCleanAllCommits(); break;
        case '0': console.log('Operation cancelled by user.'); break;
        default:
            console.log('Invalid option selected. Please try again.');
            await opShowBackupMenu();
            break;
    }
}

async function opDeleteRemoteRepo() {
    console.log(`\n=== ${TOOL_DIR} - Delete GitHub Repository ===`);
    console.log('Operation: --delete-repo');
    if (!checkCommandExists('gh')) {
        console.error('GitHub CLI (gh) is not installed. Please install it from https://cli.github.com/ to use this feature.');
        return;
    }
    try {
        const authStatus = runCommand('gh auth status', {}, true);
        console.log('Checking GitHub CLI authentication and permissions...');
        if (!authStatus.includes('delete_repo')) {
            console.log('Missing "delete_repo" scope required for repository deletion.');
            console.log('Requesting additional permissions...');
            const requestPerms = await askQuestion('Grant "delete_repo" permission to GitHub CLI? (Y/N): ');
            if (requestPerms.toLowerCase() !== 'y') {
                console.log('Repository deletion requires "delete_repo" scope. Operation cancelled.');
                return;
            }
            try {
                console.log('Opening new command window for GitHub CLI authentication...');
                console.log('Please complete the authentication in the new window that will open.');
                console.log('After authentication is complete, press any key here to continue...');
                const isWindows = process.platform === 'win32';
                if (isWindows) {
                    const authCommand = 'gh auth refresh -h github.com -s delete_repo; echo.; echo Authentication completed. You can close this window.; pause';
                    const powershellCmd = `Start-Process cmd -ArgumentList '/k','${authCommand}' -WindowStyle Normal`;
                    execSync(`powershell -Command "${powershellCmd}"`, { shell: true });
                } else {
                    execSync('gnome-terminal -- bash -c "gh auth refresh -h github.com -s delete_repo; read -p \\"Press Enter to close this window...\\"" &', { shell: true });
                }
                await askQuestion('Press Enter after completing authentication in the new window...');
                console.log('Verifying updated permissions...');
                await new Promise(resolve => setTimeout(resolve, 2000));
                const newAuthStatus = runCommand('gh auth status', {}, true);
                if (!newAuthStatus.includes('delete_repo')) {
                    console.error('Failed to obtain delete_repo scope. Please manually run: gh auth login --scopes "repo,workflow,delete_repo"');
                    return;
                }
                console.log('Successfully updated GitHub CLI permissions.');
            } catch (refreshError) {
                console.error('Failed to refresh GitHub CLI authentication.');
                console.error('Please manually run: gh auth login --scopes "repo,workflow,delete_repo"');
                return;
            }
        } else {
            console.log('GitHub CLI has required permissions for repository deletion.');
        }
    } catch (error) {
        console.error('GitHub CLI is not authenticated. Please run "gh auth login" with scopes: repo, workflow, delete_repo.');
        return;
    }
    const repoFullName = await askQuestion('Enter the full GitHub repository name to delete (e.g., username/repository-name): ');
    if (!repoFullName || !repoFullName.includes('/')) {
        console.error('Invalid repository name format. It must be in "username/repository-name" format. Deletion cancelled.');
        return;
    }
    console.log(`Verifying existence of GitHub repository: ${repoFullName}`);
    try {
        runCommand(`gh repo view ${repoFullName}`, {}, true);
        console.log(`Repository ${repoFullName} found on GitHub.`);
    } catch (e) {
        console.error(`Repository "${repoFullName}" was not found on GitHub or you do not have access to it. Deletion cancelled.`);
        return;
    }
    const confirmRepoName = await askQuestion(`WARNING: This will PERMANENTLY DELETE the repository "${repoFullName}" from GitHub.\nThis action CANNOT be undone.\nTo confirm, please type the full repository name ("${repoFullName}") again: `);
    if (confirmRepoName !== repoFullName) {
        console.log('Repository name mismatch. Deletion operation has been cancelled.');
        return;
    }
    console.log(`Proceeding with deletion of "${repoFullName}" from GitHub...`);
    const deleteCommand = `gh repo delete ${repoFullName} --yes`;
    try {
        console.log(`Executing command: ${deleteCommand}`);
        runCommand(deleteCommand);
        console.log(`Successfully deleted GitHub repository: ${repoFullName}`);
        try {
            const currentRemoteUrl = runCommand('git remote get-url origin', {}, true);
            if (currentRemoteUrl && currentRemoteUrl.includes(repoFullName)) {
                console.log('Removing local remote \'origin\' that pointed to the deleted repository.');
                runCommandStdIO('git remote remove origin');
                console.log('Successfully removed local remote \'origin\'.');
            }
        } catch (e) {
            console.log('No local remote \'origin\' found, or an error occurred while checking/removing it.');
        }
    } catch (error) {
        const execStderr = error.stderr ? error.stderr.toString().trim() : "";
        console.error(`Failed to delete GitHub repository ${repoFullName}. Error: ${execStderr || error.message}`);
        if ((execStderr || error.message).includes('delete_repo')) {
            console.error('GitHub token is missing the "delete_repo" scope even after refresh attempt.');
            console.error('Please manually run: gh auth login --scopes "repo,workflow,delete_repo"');
        } else if ((execStderr || error.message).includes('403') || (execStderr || error.message).includes('admin rights')) {
            console.error('You do not have admin rights to this repository.');
            console.error('Only repository owners or admins can delete repositories.');
        } else {
            console.error(`Command failed with status: ${error.status || 'N/A'}`);
        }
    }
}

async function handleOperationMode() {
    console.log(`${TOOL_DIR} - Running in Operation Mode`);
    console.log(`Project Root: ${projectRoot}, Arguments: ${process.argv.slice(2).join(' ')}`);
    try {
        process.chdir(projectRoot);
        console.log(`Successfully changed working directory to: ${projectRoot}`);
    } catch (err) {
        console.error(`Critical Error: Failed to change working directory to ${projectRoot}. Operations cannot proceed.`, err.stack || err);
        return;
    }
    const args = process.argv.slice(2);
    const command = args[0];
    const commandArgs = args.slice(1);
    switch (command) {
        case '--init':
            await opInitBackup();
            break;
        case '--qbackup':
            await opQuickBackup();
            break;
        case '--commit':
            await opCommitWithMessage(commandArgs.join(' '));
            break;
        case '--menu':
            await opShowBackupMenu();
            break;
        case '--clean-history':
            await opCleanOldUserCommits();
            break;
        case '--clean-all':
            await opCleanAllCommits();
            break;
        case '--delete-repo':
        case '--delrepo':
            await opDeleteRemoteRepo();
            break;
        case '--help':
        default:
            showOperationMenu();
            break;
    }
}

async function main() {
    if (isOpMode) {
        await handleOperationMode();
    } else {
        await handleInstallMode();
    }
    rl.close();
    setTimeout(() => { process.exit(0); }, 500);
}

main().catch(err => {
    console.error(`An unhandled error occurred in the main execution block: ${err.message}`, err.stack || err);
    console.error('The application encountered an unexpected error and will now terminate.');
    if (rl && typeof rl.close === 'function') {
        rl.close();
    }
    setTimeout(() => { process.exit(1); }, 500);
});
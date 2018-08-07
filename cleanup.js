const readline = require("readline");
const spawn = require("cross-spawn");

const ResGroup = process.env.RES_GROUP || "";
const AcrName = process.env.ACR_NAME || "";

function getRepoNames() {
    const repoNames = (process.env.REPO_NAMES || "").trim();
    return (!repoNames ? [] : repoNames.split(","));
}

function toMegabytes(bytes) {
    return bytes / 1024 / 1024;
}

function toGigabytes(bytes) {
    return toMegabytes(bytes) / 1024;
}

const RepoNames = getRepoNames();

function questionAsync(question, muted) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl._writeToOutput = function _writeToOutput(stringToWrite) {
        rl.line = rl.line || "";
        if (rl.stdoutMuted)
            rl.output.write("\x1B[2K\x1B[200D" + rl.query + "[" + ((rl.line.length % 2 == 1) ? "=-" : "-=") + "]");
        else
            rl.output.write(stringToWrite);
    };

    return new Promise((res, _) => {
        rl.stdoutMuted = muted;
        rl.query = question;
        rl.question(rl.query, function (value) {
            if (rl.stdoutMuted) rl.output.write("\n");
            rl.close();
            res(value);
        });
    });
}

async function boolQuestion(question, def) {
    const defAnswer = def ? "Yes" : "No";

    let result = undefined;
    while (typeof result === "undefined") {
        const res = (await questionAsync(`${question} (Yes/No, default ${defAnswer}): `) || defAnswer).toLowerCase();
        if (res === "yes") result = true;
        else if (res === "no") result = false;
    }
    return result;
}

function getAcrUsage() {
    const res = spawn.sync("az", ["acr", "show-usage", "--resource-group", ResGroup, "--name", AcrName]);
    if (res.status !== 0) {
        throw new Error("The call to get the usage of the ACR failed.");
    }

    return JSON.parse(String(res.output[1])).value[0];
}

async function processRepository(repoName) {
    console.info("Now checking repository '" + repoName + "' for untagged images...");

    let res = spawn.sync("az", ["acr", "repository", "show-manifests", "--resource-group", ResGroup, "--name", AcrName, "--repository", repoName]);
    if (res.status !== 0) {
        throw new Error("The call to get the manifests from the ACR failed.");
    }

    const manifests = JSON.parse(String(res.output[1]));
    const totalCount = manifests.length;

    let i = manifests.length - 1;
    while (i >= 0) {
        const manifest = manifests[i];
        if (Array.isArray(manifest.tags) && !!manifest.tags.length) {
            manifests.splice(i, 1);
        }
        i--;
    }

    if (!manifests.length) {
        console.warn("Found no untagged images in this repository.");
        return 0;
    }

    const doRemove = await boolQuestion(`Found ${manifests.length} untagged images out of ${totalCount} images in total. Do you want to continue?`, true);
    if (!doRemove) return 0;

    for (const manifest of manifests) {
        console.log(repoName + "@" + manifest.digest);
        let res = spawn.sync("az", ["acr", "repository", "delete", "--resource-group", ResGroup, "--name", AcrName, "--image", repoName + "@" + manifest.digest, "--yes"], { stdio: "inherit" });
        if (res.status !== 0) {
            throw new Error("The call to remove the untagged image from the ACR failed.");
        }
    }

    return manifests.length;
}

async function main() {
    console.info("The script arguments are as follow.", { ResGroup, AcrName, RepoNames });

    if (!AcrName || !RepoNames.length) {
        if (!AcrName) console.error("Azure Container Registry name is required.");
        if (!RepoNames.length) console.error("At least one repository has to be specified.");
        throw new Error("The input parameters are invalid.");
    }

    console.warn("The script requires you to be already logged in with the subscription you want to manage!");

    const usage = getAcrUsage();
    console.log(`Current ACR usage: ${toGigabytes(usage.currentValue).toFixed(3)} GB (${toMegabytes(usage.currentValue).toFixed(3)} MB) out of ${toGigabytes(usage.limit).toFixed(0)} GB.`);

    let removedImages = 0;
    for (const repoName of RepoNames) {
        removedImages += await processRepository(repoName);
    }

    if (!removedImages) {
        console.warn("Nothing to do, exiting now...");
        return;
    }

    const newUsage = getAcrUsage();
    console.log(`ACR usage after cleanup: ${toGigabytes(newUsage.currentValue).toFixed(3)} GB (${toMegabytes(newUsage.currentValue).toFixed(3)} MB) out of ${toGigabytes(newUsage.limit).toFixed(0)} GB.`);
    console.log(`You reclaimed ${toMegabytes(usage.currentValue - newUsage.currentValue).toFixed(3)} MB of your allowed storage space.`);
}

main().catch(_ => console.error(_));

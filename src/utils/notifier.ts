const notifier = require('toasted-notifier');

const appName = 'Relaycode';

// This is a "fire-and-forget" utility. If notifications fail for any reason
// (e.g., unsupported OS, DND mode, permissions), it should not crash the app.
const sendNotification = (options: { title: string; message: string; enableNotifications?: boolean }) => {
    // Skip notification if explicitly disabled
    if (options.enableNotifications === false) {
        return;
    }
    
    try {
        notifier.notify(
            {
                title: options.title,
                message: options.message,
                sound: false, // Keep it quiet by default
                wait: false,
            },
            (err: any) => {
                if (err) {
                    // Silently ignore errors. This is a non-critical feature.
                }
            }
        );
    } catch (err) {
        // Silently ignore errors.
    }
};

export const notifyPatchDetected = (projectId: string, enableNotifications: boolean = true) => {
    sendNotification({
        title: appName,
        message: `New patch detected for project \`${projectId}\`.`,
        enableNotifications,
    });
};

export const notifyApprovalRequired = (projectId: string, enableNotifications: boolean = true) => {
    sendNotification({
        title: appName,
        message: `Action required to approve changes for \`${projectId}\`.`,
        enableNotifications,
    });
};

export const notifySuccess = (uuid: string, enableNotifications: boolean = true) => {
    sendNotification({
        title: appName,
        message: `Patch \`${uuid}\` applied successfully.`,
        enableNotifications,
    });
};

export const notifyFailure = (uuid: string, enableNotifications: boolean = true) => {
    sendNotification({
        title: appName,
        message: `Patch \`${uuid}\` failed and was rolled back.`,
        enableNotifications,
    });
};
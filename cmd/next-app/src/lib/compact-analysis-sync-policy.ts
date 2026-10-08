/** Archive navigation reads what is stored; historic recovery requires explicit force. */
export function shouldSyncAnalysisHistory(options:{archiveReads:boolean;force:boolean;start:Date;end:Date;todayStart:Date;todayEnd:Date}):boolean {
    return !options.archiveReads || options.force || (options.end>options.todayStart && options.start<options.todayEnd);
}

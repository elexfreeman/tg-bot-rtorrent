export interface TorrentI {
	id: number;
	info_hash: string;
	name: string;
	output_folder: string;
	infoData?: TorrentStatusI;
}

export interface TorrentListRespI {
	torrents: TorrentI[];
}

export enum TorrentStateT {
	paused = 'paused',
	live = 'live',
	finished = 'finished'
}

export interface TorrentStatusI {
	state: TorrentStateT,
	file_progress: number[];
	error: any;
	progress_bytes: number;
	uploaded_bytes: number;
	total_bytes: number;
	finished: boolean;
	live: any;
}


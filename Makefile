build:
	electron-packager . once --platform=win32 --arch=x64 --overwrite --icon "app/imgs/icons/mipmap-mdpi/ic_launcher.png" --ignore \.gitignore --ignore Makefile --ignore .*\.7z --ignore '.*\.txt' --ignore \.vscode --ignore \.once_db --prune

drun:
	LDEV=1 npm start

rip:
	LDEV=1 npm run re

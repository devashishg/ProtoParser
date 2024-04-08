// Import the file system module
const fs = require('fs');

const { execSync } = require('child_process');
const clangFormat = require('clang-format');
const inputs = process.argv;

// -----------------------------------------------------------------------
// ------------------------ Request Processing ---------------------------
// -----------------------------------------------------------------------

(async () => {
  let protoFileName;
  let methodsToRemoveFilePath;
  for (const iterator in process.argv) {
    if (iterator >= 2 && iterator < 4) {
      await new Promise((resolve, reject) => {
        fs.access(`${inputs[iterator]}${iterator == 2 ? '.proto' : '' }`, (err) => {
          if (err) reject(err.message);
          else resolve();
        });
      }).catch(console.log);
    }
    if (iterator == 2) {
      protoFileName = inputs[iterator];
    } else if (iterator == 3) {
      methodsToRemoveFilePath = inputs[iterator];
    }
  }
  if (methodsToRemoveFilePath && protoFileName) {
    const parser = new ProtoShaker(protoFileName, methodsToRemoveFilePath);
    parser.start();
  } else {
    console.error(
      `Invalid Input received, please share Proto FileName including Path as first param\n second param file path to txt file where required methods are listed `
    );
  }
})();

// ----------------------------------------------------------------------
// ------------------------ Implementation ------------------------------
// ----------------------------------------------------------------------

/**
 * Class representing a ProtoShaker.
 * @class
 */
class ProtoShaker {
  #protoFileName;
  #methodsListToKeep;
  constructor(protoFileName, pathToMethodsList) {
    this.#protoFileName = protoFileName;
    const methodsListToKeep = this.#readFileContent(pathToMethodsList)
      .split('\n')
      .filter((method) => method.trim());
    this.#methodsListToKeep = methodsListToKeep;
  }

  start() {
    console.log(`Re-formatting file ${this.#protoFileName}`)
    this.#formatProtoFile(`${this.#protoFileName}.proto`);
    console.log(`Parsing Protos ...`)
    const parsedProto = this.#parseProto(this.#protoFileName);
    console.log(`Cleanup Initiated ...`);
    const cleanupData = this.#ProtoTreeShaking(
      parsedProto,
      this.#methodsListToKeep
    );
    this.#generateProto(
      cleanupData,
      this.#methodsListToKeep,
      this.#protoFileName
    );
    console.log(`New Protofile generated: ${this.#protoFileName}.output.proto`);
  }

  #setupWriter(outputFileName) {
    const writer = fs.createWriteStream(`${outputFileName}.output.proto`, {
      encoding: 'utf-8',
    });

    writer.on('error', (err) => {
      console.error('Error writing to stream:', err);
      writer.end('Error while writing the file!\n');
    });
    return writer;
  }

  // Method to read file content
  #readFileContent(filePath) {
    try {
      return fs.readFileSync(filePath, { encoding: 'utf-8' });
    } catch (error) {
      console.error(`Error reading file: ${error.message}`);
    }
  }

  // Method to parse the proto file content
  #parseProto(outputFileName) {
    const protoContent = this.#readFileContent(`${outputFileName}.proto`);

    const lines = protoContent.split('\n');
    const headers = ['syntax', 'package', 'option', 'import'];
    const messages = {};
    const methods = {};
    const enums = {};
    const headerLines = [];

    let currentEnum = '';
    let currentconstruct = '';
    let messageName = '';
    let serviceName = '';
    let independentConstruct = '';
    let skipNextLine = false;

    // Loop through each line

    const iterator = lines[Symbol.iterator]();
    let val = iterator.next();
    while (!val.done) {
      const line = val.value;
      let trimmedLine = line.trim();

      for (const head of headers) {
        if (trimmedLine.startsWith(head)) {
          headerLines.push(trimmedLine);
          break;
        }
      }
      if (trimmedLine.startsWith('/*')) {
        skipNextLine = true;
      }
      if (skipNextLine && trimmedLine.includes('*/')) {
        skipNextLine = false;
        val = iterator.next();
        continue;
      } else if (skipNextLine) {
        val = iterator.next();
        continue;
      }

      // Check for message definition
      if (
        trimmedLine &&
        trimmedLine !== '}' &&
        !skipNextLine &&
        !trimmedLine.startsWith('//')
      ) {
        if (trimmedLine.startsWith('service')) {
          currentconstruct = 'service';
          serviceName = trimmedLine.split(' ')[1];
          methods[serviceName] = [];
        } else if (trimmedLine.startsWith('message')) {
          currentconstruct = 'message';
          messageName = trimmedLine.split(' ')[1];
          messages[messageName] = { fields: [] }; // Initialize message object
        } else if (trimmedLine.startsWith('enum')) {
          independentConstruct = 'enum';
          const enumParts = trimmedLine.split(' ');
          currentEnum = enumParts[1].trim();
          if (currentconstruct === 'message') {
            currentEnum = `${currentconstruct === 'message' ? messageName + '.' :  ''}${currentEnum}`
          }
          enums[currentEnum] = {values: []};
        } else if (independentConstruct === 'enum') {
          const enumParts = trimmedLine.split('=');
          const numbr = Number(enumParts[1].replace(';', ''));
          enums[currentEnum].values[numbr] = enumParts[0].trim();
        } else if (
          currentconstruct &&
          messageName &&
          currentconstruct === 'message' &&
          messages[messageName]
        ) {
          const fieldParts = trimmedLine.split(' ');
          let obj = {
            type: fieldParts[0],
            name: fieldParts[1],
            number: parseInt(fieldParts[3], 10),
          };

          if (
            trimmedLine.startsWith('repeated') ||
            trimmedLine.startsWith('map')
          ) {
            obj = {
              type: `${fieldParts[0]} ${fieldParts[1]}`,
              name: fieldParts[2],
              number: parseInt(fieldParts[4], 10),
            };
          }
          messages[messageName].fields.push(obj);
        } else if (
          currentconstruct === 'service' &&
          trimmedLine.startsWith('rpc')
        ) {
          while (!trimmedLine.endsWith(';')) {
            let nextVal = iterator.next().value.trim();
            trimmedLine += `${trimmedLine.endsWith(')') ? ' ' : ''}${nextVal}`;
          }
          const fieldParts = trimmedLine.split(' ');

          const methodInput = fieldParts[1].split('(');

          methods[serviceName].push({
            methodName: methodInput[0],
            input: methodInput[1].trim().replace(')', ''),
            output: fieldParts[3]
              .trim()
              .replace('(', '')
              .replace(')', '')
              .replace(';', ''),
          });
        }
      } else if (trimmedLine === '}') {
        // only enum case
        if(independentConstruct === 'enum') {
          independentConstruct = '';
          currentEnum = '';
        } else if (currentconstruct === 'message') {
          currentconstruct = '';
          messageName = '';
        } else if (currentconstruct === 'service') {
          currentconstruct = '';
        }
        val = iterator.next();
        continue;
      }
      val = iterator.next();
    }

    // console.log(JSON.stringify({ messages, enums, methods, serviceName, headerLines }));
    return { messages, enums, methods, serviceName, headerLines };
  }

  #ProtoTreeShaking(
    { enums, messages, methods, serviceName, headerLines },
    methodsListToKeep
  ) {
    const methodsToKeep = methods[serviceName]
      .filter((method) => methodsListToKeep.includes(method.methodName))
      .map((method) => method.methodName);

    for (const iterator of methods[serviceName]) {
      if (methodsToKeep.includes(iterator.methodName)) {
        this.#DFSMarking(messages, enums, iterator.input, null);
        this.#DFSMarking(messages, enums, iterator.output, null);
      }
    }
    // console.log(JSON.stringify({ messages, enums, methods, serviceName, headerLines }));
    return { messages, enums, methods, headerLines, serviceName };
  }

  // Recursive visiting marker
  #DFSMarking(messages, enums, currentMessageOrType, parentMessage) {
    let typeEnum = 0;
    if (!messages[currentMessageOrType]) {
      if (
        parentMessage &&
        enums[`${parentMessage}.${currentMessageOrType}`] &&
        enums[`${parentMessage}.${currentMessageOrType}`].visited
      ) {
        return;
      } else if (
        !parentMessage ||
        (parentMessage && !enums[`${parentMessage}.${currentMessageOrType}`])
      ) {
        if (
          !enums[currentMessageOrType] ||
          enums[currentMessageOrType].visited
        ) {
          return;
        } else {
          typeEnum = 1;
        }
      } else if (enums[`${parentMessage}.${currentMessageOrType}`]) {
        typeEnum = 2;
      } else {
        return;
      }
    } else if (messages[currentMessageOrType].visited) {
      return;
    }
    if (typeEnum) {
      (typeEnum === 1) && (enums[currentMessageOrType].visited = true);
      (typeEnum === 2) && (enums[`${parentMessage}.${currentMessageOrType}`].visited = true);
      return;
    }
    messages[currentMessageOrType] && (messages[currentMessageOrType].visited = true);
    for (const iterator of messages[currentMessageOrType].fields) {
      if (iterator.type.startsWith('repeated')) {
        const typeVal = iterator.type.split(' ');
        this.#DFSMarking(messages, enums, typeVal[1], currentMessageOrType);
      } else if(iterator.type.startsWith('map'))  {
        const typeVal = iterator.type.split(' ');
        this.#DFSMarking(messages, enums, typeVal[1].replace('>', ''), currentMessageOrType);
      } else {
        this.#DFSMarking(messages, enums, iterator.type, currentMessageOrType);
      }
    }
  }

  // Method to generate the updated proto content
  #generateProto(
    { enums, messages, methods, serviceName, headerLines },
    methodsToKeep,
    protoFileName
  ) {
    const writer = this.#setupWriter(protoFileName);
    // Enum Writer
    let createEnum = (iterator, indentationSpace = '') => {
      if (!enums[iterator]) return;
      let enumName = iterator;
      const enumSplitProcessorData = iterator.split('.');
      if(enumSplitProcessorData.length >= 2) {
        enumName = enumSplitProcessorData[enumSplitProcessorData.length -1]
      }
      writer.write(`${indentationSpace}enum ${enumName} {\n`);
      for (const [index, itera] of enums[iterator].values.entries()) {
        itera && writer.write(`${indentationSpace}  ${itera} = ${index};\n`);
      }
      writer.write(`${indentationSpace}}\n`);
      delete enums[iterator].visited; 
    }

    for (const iterator of headerLines) {
      writer.write(iterator);
      writer.write('\n\n');
    }

    for (const iterator in messages) {
      if (!messages[iterator].visited) continue;

      writer.write(`message ${iterator} {\n`);
      for (const itera of messages[iterator].fields) {
        if (enums[`${iterator}.${itera.type}`]) {
          createEnum(`${iterator}.${itera.type}`, '  ');
        }
      }
      for (const itera of messages[iterator].fields) {
        writer.write(`  ${itera.type} ${itera.name} = ${itera.number};\n`);
      }
      writer.write(`}\n\n`);
    }


    for (const iterator in enums) {
      if (enums[iterator] && !enums[iterator].visited) {
        continue;
      }
      createEnum(iterator);
    }

    writer.write(`service ${serviceName} {\n`);
    for (const { methodName, input, output } of methods[serviceName]) {
      if (methodsToKeep.includes(methodName)) {
        writer.write(`  rpc ${methodName} (${input}) returns (${output});\n`);
      }
    }
    writer.write(`}\n`);
    writer.end('\n');
  }

  #formatProtoFile(filePath) {
    try {
      execSync(`${clangFormat.location} -i -style=Google ${filePath}`);
    } catch (error) {
      console.error(`Error formatting file: ${error.message}`);
    }
  }
}

// Import the file system module
const fs = require('fs');

const { execSync } = require('child_process');
const clangFormat = require('clang-format');
const inputs = process.argv;

// -----------------------------------------------------------------------
// ----------------------------- Processing ------------------------------
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
          enums[currentEnum] = [];
        } else if (independentConstruct === 'enum') {
          const enumParts = trimmedLine.split('=');
          const numbr = Number(enumParts[1].replace(';', ''));
          enums[currentEnum][numbr] = enumParts[0].trim();
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
      } else if (trimmedLine === '}' && independentConstruct === 'enum') {
        // only enum case
        independentConstruct = '';
        currentEnum = '';
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
        this.#DFSMarking(messages, iterator.input);
        this.#DFSMarking(messages, iterator.output);
      }
    }
    return { messages, enums, methods, headerLines, serviceName };
  }

  // Recursive visiting marker
  #DFSMarking(messages, rootMessage) {
    if (!messages[rootMessage] || messages[rootMessage].visited) {
      return;
    }
    messages[rootMessage].visited = true;
    for (const iterator of messages[rootMessage].fields) {
      if (!iterator.type.startsWith('repeated')) {
        this.#DFSMarking(messages, iterator.type);
      } else {
        const typeVal = iterator.type.split(' ');
        this.#DFSMarking(messages, typeVal[1]);
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
      writer.write(`${indentationSpace}enum ${iterator} {\n`);
      for (const [index, itera] of enums[iterator].entries()) {
        itera && writer.write(`${indentationSpace}  ${itera} = ${index};\n`);
      }
      writer.write(`${indentationSpace}}\n`);
    }

    for (const iterator of headerLines) {
      writer.write(iterator);
      writer.write('\n\n');
    }

    for (const iterator in messages) {
      if (!messages[iterator].visited) continue;

      writer.write(`message ${iterator} {\n`);
      for (const itera of messages[iterator].fields) {
        if (enums[itera.type]) {
          createEnum(itera.type, '  ');
          enums[itera.type].push(undefined);
        }
      }
      for (const itera of messages[iterator].fields) {
        writer.write(`  ${itera.type} ${itera.name} = ${itera.number};\n`);
      }
      writer.write(`}\n\n`);
    }


    for (const iterator in enums) {
      let enumList = enums[iterator];
      if(enumList[enumList.length-1]) {
        createEnum(iterator);
      }
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
